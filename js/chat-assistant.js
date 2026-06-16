// AI 知识库助手 - 聊天功能
document.addEventListener('DOMContentLoaded', () => {
    // ======= 配置 =======
    const EMBED_API = 'https://models.inference.ai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15';
    const CHAT_API = 'https://models.inference.ai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2023-05-15';
    const GITHUB_PAT = '__GITHUB_PAT__';  // 会被 Actions 注入
    const TOP_K = 4;                      // 取前4个最相关段落

    let index = [];
    
    // 加载搜索索引
    fetch('/search-index.json')
        .then(res => res.json())
        .then(data => {
            index = data;
            console.log(`已加载 ${index.length} 条索引`);
        })
        .catch(err => console.error('加载索引失败:', err));

    // ======= 工具函数 =======
    function cosineSim(a, b) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async function getEmbedding(text) {
        try {
            const res = await fetch(EMBED_API, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GITHUB_PAT}`,
                },
                body: JSON.stringify({ input: [text], model: 'text-embedding-3-small' }),
            });
            
            if (!res.ok) {
                throw new Error(`API request failed with status ${res.status}`);
            }
            
            const data = await res.json();
            if (data.data && data.data.length > 0) {
                return data.data[0].embedding;
            }
            throw new Error('No embedding data received');
        } catch (error) {
            console.error('获取嵌入向量失败:', error);
            return null;
        }
    }

    function retrieveContext(queryEmbedding) {
        if (!queryEmbedding || index.length === 0) return [];
        
        const scored = index.map(item => ({
            ...item,
            score: cosineSim(queryEmbedding, item.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, TOP_K);
    }

    function buildPrompt(query, contexts) {
        const contextText = contexts.map((c, i) => `[${i+1}] ${c.text}`).join('\n\n');
        return `你是一个基于个人博客内容的问答助手。请仅根据以下文章片段回答用户的问题。如果答案无法从片段中得出，请如实告知。

文章片段：
${contextText}

用户问题：${query}

请用中文给出简洁的答案，并在答案末尾以数字编号引用相关片段。`;
    }

    async function getChatResponse(messages) {
        try {
            const res = await fetch(CHAT_API, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GITHUB_PAT}`,
                },
                body: JSON.stringify({
                    messages: messages,
                    model: 'gpt-4o-mini',
                    temperature: 0.3,
                }),
            });
            
            if (!res.ok) {
                throw new Error(`Chat API failed with status ${res.status}`);
            }
            
            const data = await res.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error('获取聊天响应失败:', error);
            throw error;
        }
    }

    // ======= UI 逻辑 =======
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('userInput');

    if (!chatbox || !userInput) {
        console.error('聊天界面元素未找到');
        return;
    }

    function addMessage(role, text, sources = null) {
        const div = document.createElement('div');
        div.className = `chat-message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = text.replace(/\n/g, '<br>');
        div.appendChild(contentDiv);
        
        if (sources && sources.length > 0) {
            const sourceDiv = document.createElement('div');
            sourceDiv.className = 'message-sources';
            sourceDiv.innerHTML = '📎 引用: ' + sources.map(s => 
                `<a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>`
            ).join(', ');
            div.appendChild(sourceDiv);
        }
        
        chatbox.appendChild(div);
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    function showLoading() {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'chat-message ai loading';
        loadingDiv.id = 'loading-message';
        loadingDiv.textContent = '正在思考...';
        chatbox.appendChild(loadingDiv);
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    function hideLoading() {
        const loadingDiv = document.getElementById('loading-message');
        if (loadingDiv) {
            loadingDiv.remove();
        }
    }

    window.ask = async function() {
        const query = userInput.value.trim();
        if (!query) return;
        
        if (index.length === 0) {
            addMessage('ai', '❌ 知识库尚未加载，请稍后重试。');
            return;
        }
        
        addMessage('user', query);
        userInput.value = '';
        showLoading();

        try {
            const qEmb = await getEmbedding(query);
            if (!qEmb) {
                hideLoading();
                addMessage('ai', '❌ 无法处理您的问题，请稍后重试。');
                return;
            }
            
            const contexts = retrieveContext(qEmb);
            if (contexts.length === 0) {
                hideLoading();
                addMessage('ai', '抱歉，我在知识库中找不到相关信息来回答这个问题。');
                return;
            }
            
            const prompt = buildPrompt(query, contexts);
            const answer = await getChatResponse([
                { role: 'user', content: prompt }
            ]);
            
            hideLoading();
            addMessage('ai', answer, contexts);
        } catch (err) {
            hideLoading();
            addMessage('ai', '❌ 出错了，请稍后重试。');
            console.error('聊天错误:', err);
        }
    };

    // 支持回车发送
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            ask();
        }
    });
});
