/**
 * Telegram API 封装类
 */
export class TelegramAPI {
    constructor(botToken, proxyUrl = '') {
        this.botToken = botToken;
        this.proxyUrl = proxyUrl;
        // 如果设置了代理域名，使用代理域名，否则使用官方 API
        const apiDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.baseURL = `${apiDomain}/bot${this.botToken}`;
        this.fileDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.defaultHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
        };
    }

    /**
     * 发送文件到Telegram
     * @param {File} file - 要发送的文件
     * @param {string} chatId - 聊天ID
     * @param {string} functionName - API方法名（如：sendPhoto, sendDocument等）
     * @param {string} functionType - 文件类型参数名（如：photo, document等）
     * @returns {Promise<Object>} API响应结果
     */
    async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '') {
        const formData = new FormData();

        formData.append('chat_id', chatId);
        if (fileName) {
            formData.append(functionType, file, fileName);
        } else {
            formData.append(functionType, file);
        }
        if (caption) {
            formData.append('caption', caption);
        }

        const response = await fetch(`${this.baseURL}/${functionName}`, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: formData
        });
        console.log('Telegram API response:', response.status, response.statusText);
        if (!response.ok) {
            throw new Error(`Telegram API error: ${response.statusText}`);
        }

        // 解析响应数据
        const responseData = await response.json();

        return responseData;
    }

    /**
     * 获取文件信息
     * @param {Object} responseData - Telegram API响应数据
     * @returns {Object|null} 文件信息对象或null
     */
    getFileInfo(responseData) {
        const getFileDetails = (file) => ({
            file_id: file.file_id,
            file_name: file.file_name || file.file_unique_id,
            file_size: file.file_size,
        });

        try {
            if (!responseData.ok) {
                console.error('Telegram API error:', responseData.description);
                return null;
            }

            if (responseData.result.photo) {
                const largestPhoto = responseData.result.photo.reduce((prev, current) =>
                    (prev.file_size > current.file_size) ? prev : current
                );
                return getFileDetails(largestPhoto);
            }

            if (responseData.result.video) {
                return getFileDetails(responseData.result.video);
            }

            if (responseData.result.audio) {
                return getFileDetails(responseData.result.audio);
            }

            if (responseData.result.document) {
                return getFileDetails(responseData.result.document);
            }

            return null;
        } catch (error) {
            console.error('Error parsing Telegram response:', error.message);
            return null;
        }
    }

    /**
     * 获取文件路径
     * @param {string} fileId - 文件ID
     * @returns {Promise<string|null>} 文件路径或null
     */
    async getFilePath(fileId) {
        try {
            const url = `${this.baseURL}/getFile?file_id=${fileId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: this.defaultHeaders,
            });

            const responseData = await response.json();
            if (responseData.ok) {
                return responseData.result.file_path;
            } else {
                return null;
            }
        } catch (error) {
            console.error('Error getting file path:', error.message);
            return null;
        }
    }

    /**
     * 获取文件内容
     * @param {string} fileId - 文件ID
     * @returns {Promise<Response>} 文件响应
     */
    async getFileContent(fileId) {
        const filePath = await this.getFilePath(fileId);
        if (!filePath) {
            throw new Error(`File path not found for fileId: ${fileId}`);
        }

        const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
        const response = await fetch(fullURL, {
            headers: this.defaultHeaders
        });

        return response;
    }

    static SEND_METHOD = {
        photo: 'sendPhoto',
        video: 'sendVideo',
        animation: 'sendAnimation',
        audio: 'sendAudio',
        document: 'sendDocument',
    };

    /**
     * 用 file_id 直接转发到目标聊天（免下载再传）
     * @param {string} chatId - 目标聊天ID（存储频道）
     * @param {string} fileId - 已存在于本bot下的file_id
     * @param {string} functionType - 媒体类型（photo/document/video/audio/animation）
     * @param {string} caption - 可选说明
     * @returns {Promise<Object>} API响应
     */
    async sendById(chatId, fileId, functionType, caption = '') {
        const method = TelegramAPI.SEND_METHOD[functionType] || 'sendDocument';
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append(functionType, fileId); // file_id 作为字符串值，Telegram 直接转发
        if (caption) {
            formData.append('caption', caption);
        }
        const response = await fetch(`${this.baseURL}/${method}`, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: formData
        });

        console.log('Telegram API sendById response:', response.status, response.statusText);
        if (!response.ok) {
            throw new Error(`Telegram API error: ${response.statusText}`);
        }
        return await response.json();
    }

    /**
     * 发送文本消息（回发上传链接）
     * @param {string} chatId - 目标聊天ID
     * @param {string} text - 消息内容
     * @param {string} parseMode - 解析模式（HTML/MarkdownV2，默认HTML）
     * @param {Object} extra - 其他可选参数
     * @returns {Promise<Object>} API响应
     */
    async sendMessage(chatId, text, parseMode = 'HTML', extra = {}) {
        const response = await fetch(`${this.baseURL}/sendMessage`, {
            method: 'POST',
            headers: { ...this.defaultHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, ...extra })
        });
        return await response.json();
    }

    /**
     * 设置 webhook
     * @param {string} url - webhook 公网 URL
     * @param {string} secret - secret_token（用于来源校验）
     * @param {Object} opts - { allowed_updates, drop_pending_updates }
     * @returns {Promise<Object>} API响应
     */
    async setWebhook(url, secret = '', opts = {}) {
        const body = { url };
        if (secret) body.secret_token = secret;
        if (opts.allowed_updates) body.allowed_updates = opts.allowed_updates;
        if (opts.drop_pending_updates) body.drop_pending_updates = true;
        const response = await fetch(`${this.baseURL}/setWebhook`, {
            method: 'POST',
            headers: { ...this.defaultHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await response.json();
    }

    /**
     * 获取当前 webhook 信息
     * @returns {Promise<Object>} API响应
     */
    async getWebhookInfo() {
        const response = await fetch(`${this.baseURL}/getWebhookInfo`, {
            method: 'GET',
            headers: this.defaultHeaders
        });
        return await response.json();
    }

}