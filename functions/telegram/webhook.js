/**
 * Telegram 收图入库 webhook
 *
 * 用户私聊给 bot 发图片/文档/视频/音频时，Telegram 推 update 到此端点。
 * 本 handler 负责：
 *   1. 校验 X-Telegram-Bot-Api-Secret-Token 来源
 *   2. 幂等去重（防 Telegram 退避重试导致重复入库）
 *   3. 把文件通过 file_id 转发存进目标 TG 存储频道（复用 TelegramNew 渠道）
 *   4. 写 KV 记录 + 更新索引（复用 buildUniqueFileId / endUpload / addFileToIndex）
 *   5. 回发用户一个访问链接
 *
 * 端点放在顶层 /telegram/webhook，避开 functions/api/manage/_middleware.js 的管理员鉴权。
 * 路由约定：functions/telegram/webhook.js -> /telegram/webhook（generate-routes.js 自动映射）
 */

import { getDatabase } from '../utils/databaseAdapter.js';
import { fetchPageConfig, fetchUploadConfig } from '../utils/sysConfig.js';
import { TelegramAPI } from '../utils/storage/telegramAPI.js';
import {
    moderateContent, endUpload, buildUniqueFileId, getUploadIp, getIPAddress,
} from '../upload/uploadTools.js';

const DEFAULT_TG_DOMAIN = 'https://api.telegram.org';

/**
 * webhook 入口（接收所有 HTTP 方法，仅处理 POST）
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const url = new URL(request.url);
    const db = getDatabase(env);
    // 供 buildUniqueFileId / endUpload 复用
    context.url = url;

    // 1. 来源校验（secret）
    const secret = env.TG_WEBHOOK_SECRET || (await db.get('manage@sysConfig@telegram@webhookSecret'));
    if (secret) {
        const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (header !== secret) {
            return new Response('Unauthorized', { status: 401 });
        }
    }

    // 2. 解析 update
    let update;
    try {
        update = await request.json();
    } catch (e) {
        return new Response('Bad Request', { status: 400 });
    }
    const updateId = update?.update_id;

    // 3. 幂等：先占位，命中直接确认（TTL 短，防并发重复）
    const seenKey = updateId != null ? `webhook@seen@${updateId}` : null;
    if (seenKey) {
        if (await db.get(seenKey)) {
            return new Response('OK', { status: 200 });
        }
        await db.put(seenKey, '1', { expirationTtl: 600 });
    }

    try {
        const msg = update?.message || update?.channel_post;
        if (!msg) {
            // 非消息类 update（如 callback_query），直接确认
            return new Response('OK', { status: 200 });
        }

        const chatId = msg.chat?.id;
        const media = extractMedia(msg);
        if (!media) {
            // 纯文本 / 无可入库媒体，确认即可
            return new Response('OK', { status: 200 });
        }

        // 5. 选择目标存储渠道（收图 bot 必须为该渠道的 bot）
        const uploadConfig = await fetchUploadConfig(env, context);
        const tgChannels = (uploadConfig.telegram?.channels || []).filter(c => c && c.botToken);
        const channel = selectChannel(tgChannels, url);
        if (!channel) {
            // 无可用渠道属于配置问题，返回 500 让 Telegram 退避重试以便管理员修复后自动补投
            if (seenKey) await db.delete(seenKey);
            console.error('[tg-webhook] No enabled Telegram channel configured');
            return new Response('No TG channel', { status: 500 });
        }

        const tgApi = new TelegramAPI(channel.botToken, channel.proxyUrl || '');

        // 6. 用 file_id 转发存进存储频道，取回【同 bot 的新 file_id】
        let tgFileId = media.fileId;
        let fwdSize = media.fileSize || 0;
        try {
            const fwd = await tgApi.sendById(channel.chatId, media.fileId, media.type, media.caption || '');
            const info = tgApi.getFileInfo(fwd);
            if (info?.file_id) {
                tgFileId = info.file_id;
                fwdSize = info.file_size || fwdSize;
            } else {
                console.warn('[tg-webhook] sendById succeeded but could not parse new file_id, use original');
            }
        } catch (e) {
            // 大小超限等：回退用原 file_id（仍属同一 bot，出图可解析）
            console.warn(`[tg-webhook] forward failed, keep original file_id: ${e.message}`);
        }

        // 7. 构造 metadata
        const fileType = media.mimeType || 'application/octet-stream';
        const fileName = media.fileName || `tg_${tgFileId}`;
        const metadata = {
            FileName: fileName,
            FileType: fileType,
            FileSize: ((fwdSize || 0) / 1024 / 1024).toFixed(2),
            FileSizeBytes: fwdSize || 0,
            UploadIP: getUploadIp(request) || 'Telegram',
            UploadAddress: await getIPAddress(env, getUploadIp(request) || null).catch(() => ''),
            ListType: 'None',
            TimeStamp: Date.now(),
            Label: 'None',
            Directory: '', // 根目录：管理端文件夹默认可见
            Tags: [],
        };
        if (media.width && media.height) {
            metadata.Width = media.width;
            metadata.Height = media.height;
        }

        // 图像审查（用 TG 文件地址，与 upload/index.js 一致）
        try {
            const tgFilePath = await tgApi.getFilePath(tgFileId);
            if (tgFilePath) {
                const domain = channel.proxyUrl ? `https://${channel.proxyUrl}` : DEFAULT_TG_DOMAIN;
                metadata.Label = await moderateContent(env, `${domain}/file/bot${channel.botToken}/${tgFilePath}`);
            }
        } catch (e) {
            console.warn(`[tg-webhook] moderation failed: ${e.message}`);
        }

        // 8. 渠道身份（必须与出图匹配：findConfiguredChannel 优先按 ChannelName 匹配）
        metadata.Channel = 'TelegramNew';
        metadata.ChannelName = channel.name;
        metadata.TgFileId = tgFileId;

        // 9. 构造 fullId（内部查重）
        const fullId = await buildUniqueFileId(context, fileName, fileType);

        // 10. 写 KV
        await db.put(fullId, '', { metadata });

        // 11. 更新索引（内部清缓存 + addFileToIndex）
        const uploadContext = { env, waitUntil, uploadConfig, url };
        waitUntil(endUpload(uploadContext, fullId, metadata));

        // 12. 公网访问链接
        const pageConfig = await fetchPageConfig(env);
        const urlPrefix = pageConfig.config?.find(c => c.id === 'urlPrefix')?.value || '';
        const fileUrl = urlPrefix
            ? `${urlPrefix.replace(/\/+$/, '')}/${fullId}`
            : `${url.origin}/file/${fullId}`;

        // 13. 回发用户
        try {
            await tgApi.sendMessage(chatId, `已保存：${fileName}\n${fileUrl}`);
        } catch (e) {
            console.warn(`[tg-webhook] reply failed: ${e.message}`);
        }

        console.log(`[tg-webhook] saved ${fullId} (media=${media.type}, channel=${channel.name})`);
        return new Response('OK', { status: 200 });

    } catch (e) {
        console.error('[tg-webhook] error:', e);
        if (seenKey) await db.delete(seenKey); // 失败删除占位，允许 Telegram 重试
        return new Response('Error', { status: 500 });
    }
}

/**
 * 从 update.message 提取媒体信息
 * @returns {null|{type, fileId, mimeType, fileSize, width, height, fileName, caption}}
 */
function extractMedia(msg) {
    // photo 是数组，取末位（最大尺寸）
    if (Array.isArray(msg.photo) && msg.photo.length) {
        const p = msg.photo[msg.photo.length - 1];
        return {
            type: 'photo',
            fileId: p.file_id,
            mimeType: 'image/jpeg',
            fileSize: p.file_size,
            width: p.width,
            height: p.height,
            fileName: `photo_${p.file_id}.jpg`,
            caption: msg.caption,
        };
    }
    if (msg.document) {
        return {
            type: 'document',
            fileId: msg.document.file_id,
            mimeType: msg.document.mime_type || 'application/octet-stream',
            fileSize: msg.document.file_size,
            fileName: msg.document.file_name || `doc_${msg.document.file_id}`,
            caption: msg.caption,
        };
    }
    if (msg.video) {
        return {
            type: 'video',
            fileId: msg.video.file_id,
            mimeType: msg.video.mime_type || 'video/mp4',
            fileSize: msg.video.file_size,
            width: msg.video.width,
            height: msg.video.height,
            fileName: msg.video.file_name || `video_${msg.video.file_id}.mp4`,
            caption: msg.caption,
        };
    }
    if (msg.animation) {
        return {
            type: 'animation',
            fileId: msg.animation.file_id,
            mimeType: msg.animation.mime_type || 'image/gif',
            fileSize: msg.animation.file_size,
            width: msg.animation.width,
            height: msg.animation.height,
            fileName: msg.animation.file_name || `anim_${msg.animation.file_id}.gif`,
            caption: msg.caption,
        };
    }
    if (msg.audio) {
        return {
            type: 'audio',
            fileId: msg.audio.file_id,
            mimeType: msg.audio.mime_type || 'audio/mpeg',
            fileSize: msg.audio.file_size,
            fileName: msg.audio.file_name || `audio_${msg.audio.file_id}`,
            caption: msg.caption,
        };
    }
    return null;
}

/**
 * 选择目标 TG 存储渠道
 * 支持多渠道：webhook URL 可带 channelName；缺省为第一个 enabled 渠道
 */
function selectChannel(channels, url) {
    if (!channels.length) return null;
    const byName = url.searchParams.get('channelName');
    if (byName) {
        const hit = channels.find(c => c.name === byName);
        if (hit) return hit;
    }
    return channels[0];
}
