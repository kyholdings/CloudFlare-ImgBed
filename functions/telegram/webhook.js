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
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from '../utils/purgeCache';
import { removeFileFromIndex } from '../utils/indexManager.js';

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
        // 处理「删除按钮」点击（callback_query）—— 从私聊侧同步删除管理端文件
        const cq = update?.callback_query;
        if (cq?.data) {
            return await handleDeleteQuery(context, db, update);
        }

        const msg = update?.message || update?.channel_post;
        if (!msg) {
            // 非消息类 update（如 channel_post 缺内容等），直接确认
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
        let tgMessageId = null;
        try {
            const fwd = await tgApi.sendById(channel.chatId, media.fileId, media.type, media.caption || '');
            const info = tgApi.getFileInfo(fwd);
            if (info?.file_id) {
                tgFileId = info.file_id;
                fwdSize = info.file_size || fwdSize;
            } else {
                console.warn('[tg-webhook] sendById succeeded but could not parse new file_id, use original');
            }
            if (fwd?.result?.message_id) {
                // 频道里那条存图消息的 message_id，供删除按钮回执时 deleteMessage 用
                tgMessageId = fwd.result.message_id;
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
        if (tgMessageId) metadata.TgMessageId = tgMessageId;
        // 用户私聊里那条原始上传图（bot 与存储 bot 一致，可删除）
        metadata.UserChatId = chatId;
        metadata.UserMessageId = msg.message_id;

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

        // 13. 回发用户（附「删除」按钮：点击经 callback_query 同步删管理端文件）
        const deleteToken = await makeDeleteToken(db, fullId);
        // 关闭链接预览：否则 URL 会让 TG 自动把图缩略图画进回执，造成"多一张图"的观感
        const replyExtra = { link_preview_options: { is_disabled: true } };
        if (deleteToken) {
            replyExtra.reply_markup = { inline_keyboard: [[{ text: '🗑️ 删除', callback_data: deleteToken }]] };
        }
        try {
            const replyRes = await tgApi.sendMessage(chatId, `已保存：${fileName}\n${fileUrl}`, 'HTML', replyExtra);
            // 记录回执消息 ID，供「管理端删除」时联动删掉这条回执/删除按钮
            const receiptMsgId = replyRes?.result?.message_id;
            if (receiptMsgId != null) {
                await db.put(fullId, '', { metadata: { ...metadata, ReceiptMessageId: receiptMsgId } });
            }
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

/**
 * 生成「删除」按钮的短 token（callback_data 上限 64 字节，fullId 过长，用短 token 映射到 fullId）
 * KV 存 webhook@del@<token> -> fullId，TTL 7 天
 */
async function makeDeleteToken(db, fullId) {
    try {
        const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
        await db.put(`webhook@del@${token}`, fullId, { expirationTtl: 7 * 24 * 3600 });
        return token;
    } catch (e) {
        console.warn(`[tg-webhook] makeDeleteToken failed: ${e.message}`);
        return null;
    }
}

/**
 * 解析 callback_query 归属的 TG 存储渠道
 * 优先按文件的 ChannelName 匹配（委托调用方传入 img.metadata.ChannelName），
 * 否则按按钮所在私聊 chat.id 匹配，最后兜底第一个 enabled 渠道。
 */
async function resolveCqChannel(env, cq, preferredName) {
    const uploadConfig = await fetchUploadConfig(env, { env });
    const tgChannels = (uploadConfig.telegram?.channels || []).filter(c => c && c.botToken);
    if (!tgChannels.length) return null;
    if (preferredName) {
        const hit = tgChannels.find(c => c.name === preferredName);
        if (hit) return hit;
    }
    const priChatId = cq?.message?.chat?.id;
    if (priChatId != null) {
        const hit = tgChannels.find(c => String(c.chatId) === String(priChatId));
        if (hit) return hit;
    }
    return tgChannels[0];
}

/**
 * 处理「删除按钮」点击：私聊侧删除 -> 同步删管理端 KV 记录 + 清缓存 + 更新索引 + 删存储频道里那条存图消息
 */
async function handleDeleteQuery(context, db, update) {
    const { env, waitUntil, request } = context;
    const cq = update?.callback_query || {};
    const chat = cq.message?.chat;
    const msgId = cq.message?.message_id;
    const userId = cq.from?.id;

    const token = (cq.data || '').trim();
    if (!token) return new Response('OK', { status: 200 });

    const origin = new URL(request.url).origin;
    const delKey = `webhook@del@${token}`;
    const fullId = await db.get(delKey).catch(() => null);
    const img = fullId ? await db.getWithMetadata(fullId).catch(() => null) : null;
    const meta = (img && img.metadata) || {};

    const channel = await resolveCqChannel(env, cq, meta.ChannelName);
    const tgApi = channel ? new TelegramAPI(channel.botToken, channel.proxyUrl || '') : null;

    // 票据失效 / 文件已被删：回执提示，顺手删掉按钮那条确认消息
    if (!fullId || !img) {
        try {
            if (tgApi) await tgApi.answerCallbackQuery(cq.id, fullId ? '文件不存在' : '链接已失效');
        } catch (e) { /* 忽略 */ }
        if (tgApi && chat?.id && msgId) {
            try { await tgApi.deleteMessage(chat.id, msgId); } catch (e) { /* 忽略 */ }
        }
        if (fullId) await db.delete(delKey).catch(() => {});
        return new Response('OK', { status: 200 });
    }

    const fails = [];

    // 1. 删「存储频道」里的存图消息（真正把文件本体从 Telegram 移除；支持分片多消息）
    let channelDeleted = false;
    const channelMsgIds = (Array.isArray(meta.TgMessageIds) && meta.TgMessageIds.length)
        ? meta.TgMessageIds
        : (meta.TgMessageId != null ? [meta.TgMessageId] : []);
    if (tgApi && channel?.chatId && channelMsgIds.length) {
        for (const mid of channelMsgIds) {
            try {
                const r = await tgApi.deleteMessage(channel.chatId, mid);
                if (r?.ok) { channelDeleted = true; }
                else { fails.push(`频道消息: ${r?.description || 'unknown'}(id=${mid})`); }
            } catch (e) {
                console.warn(`[tg-webhook] delete channel msg failed: ${e.message}`);
                fails.push(`频道消息异常: ${e.message}(id=${mid})`);
            }
        }
    } else if (!channelMsgIds.length) {
        fails.push('缺频道消息ID(旧文件)');
    }

    // 2. 删用户「私聊」里那条原始上传图（用户想删的就是它）
    let userDeleted = false;
    if (tgApi && meta.UserChatId != null && meta.UserMessageId != null) {
        try {
            const r = await tgApi.deleteMessage(meta.UserChatId, meta.UserMessageId);
            userDeleted = !!r?.ok;
            if (!r?.ok) fails.push(`私聊原始图: ${r?.description || 'unknown'}`);
        } catch (e) {
            console.warn(`[tg-webhook] delete user original msg failed: ${e.message}`);
            fails.push(`私聊原始图异常: ${e.message}`);
        }
    }

    // 3. 删管理端 KV 记录 + 清 CDN/列表缓存 + 更新索引
    try {
        const cdnUrl = `${origin}/file/${fullId}`;
        await db.delete(fullId);
        await purgeCFCache(env, cdnUrl).catch(() => {});
        const normalizedFolder = fullId.split('/').slice(0, -1).join('/');
        await purgeRandomFileListCache(origin, normalizedFolder).catch(() => {});
        await purgePublicFileListCache(origin, normalizedFolder).catch(() => {});
        waitUntil(removeFileFromIndex(context, fullId));
    } catch (e) {
        console.error(`[tg-webhook] db delete failed: ${e.message}`);
        fails.push(`数据库: ${e.message}`);
    }

    // 4. 回执（失败时把原因透给用户，便于定位）
    try {
        const summary = fails.length ? `部分失败| ${fails.join('; ')}` : '已删除';
        await tgApi.answerCallbackQuery(cq.id, summary.slice(0, 200));
    } catch (e) {
        console.warn(`[tg-webhook] answerCallbackQuery failed: ${e.message}`);
    }

    // 5. 删带按钮的那条确认消息（尽力）
    if (tgApi && chat?.id && msgId) {
        try { await tgApi.deleteMessage(chat.id, msgId); } catch (e) { /* 忽略 */ }
    }

    await db.delete(delKey).catch(() => {});
    console.log(`[tg-webhook] callback delete ${fullId}: channel=${channelDeleted} user=${userDeleted} fails=${JSON.stringify(fails)}`);
    return new Response('OK', { status: 200 });
}
