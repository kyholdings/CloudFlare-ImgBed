/**
 * Telegram webhook 一键设置端点（管理员触发）
 *
 * 位于 /api/manage/telegram/setWebhook，自动经过 functions/api/manage/_middleware.js 的
 * AUTH_SCOPE.ADMIN 鉴权（默认 admin 未配置时放行）。管理员登录后调用一次即可把
 * Telegram webhook 指向 https://<域名>/telegram/webhook 并设置 secret。
 *
 * 路由：functions/api/manage/telegram/setWebhook.js -> /api/manage/telegram/setWebhook
 */

import { getDatabase } from '../../../utils/databaseAdapter.js';
import { fetchUploadConfig } from '../../../utils/sysConfig.js';
import { TelegramAPI } from '../../../utils/storage/telegramAPI.js';

/**
 * 读取请求参数：GET 用 query，POST 用 JSON 表单（兼容 urlencoded/FormData）
 */
async function readParams(request) {
    const method = request.method;
    if (method === 'GET') {
        return Object.fromEntries(new URL(request.url).searchParams);
    }
    const contentType = request.headers.get('content-type') || '';
    try {
        if (contentType.includes('application/json')) {
            return await request.json();
        }
        if (contentType.includes('application/x-www-form-urlencoded')) {
            return Object.fromEntries(new URLSearchParams(await request.text()));
        }
        if (contentType.includes('multipart/form-data')) {
            return Object.fromEntries((await request.formData()).entries());
        }
    } catch (e) {
        /* 解析失败按空处理 */
    }
    try {
        return await request.json();
    } catch (e) {
        return {};
    }
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const db = getDatabase(env);

    const p = await readParams(request);
    const channelName = p.channelName || url.searchParams.get('channelName') || '';

    // 选渠道
    const uploadConfig = await fetchUploadConfig(env, context);
    const tgChannels = (uploadConfig.telegram?.channels || []).filter(c => c && c.botToken);
    let channel = channelName
        ? tgChannels.find(c => c.name === channelName)
        : (tgChannels.find(c => c.name === 'Telegram_env') || tgChannels[0]);

    if (!channel) {
        return new Response(JSON.stringify({ ok: false, error: 'No Telegram channel configured' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 目标 webhook URL：默认本机 origin + /telegram/webhook；本地/隧道测试可用 p.url 覆盖
    const webhookUrl = p.url || `${url.origin}/telegram/webhook`;
    const secret = p.secret || env.TG_WEBHOOK_SECRET || '';
    const drop = p.drop_pending_updates === 'true';
    const allowed = p.allowed_updates ? JSON.parse(p.allowed_updates) : null;

    const tgApi = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    const result = await tgApi.setWebhook(webhookUrl, secret, {
        drop_pending_updates: drop,
        allowed_updates: allowed,
    });

    // 保存 secret 供接收端校验（env 优先级更高）
    if (secret && p.saveSecret !== 'false') {
        await db.put('manage@sysConfig@telegram@webhookSecret', secret);
    }

    return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
