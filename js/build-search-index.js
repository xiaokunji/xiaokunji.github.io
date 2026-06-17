// build-search-index.js
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// 从命令行参数或环境变量中获取 CONTENT_DIR
const CONTENT_DIR_ARG = process.argv.find(arg => arg.startsWith('--content-dir='))?.split('=')[1];
const CONTENT_DIR = CONTENT_DIR_ARG || process.env.CONTENT_DIR || 'content';
const CACHE_DIR = '.cache';
const CACHE_FILE = path.join(CACHE_DIR, 'doc_hashes.json');
const INDEX_FILE = 'static/search-index.json';
const EMBEDDING_ENDPOINT = 'https://models.inference.ai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15';
// 从命令行参数或环境变量中获取 GITHUB_PAT
const GITHUB_PAT = process.argv.find(arg => arg.startsWith('--pat='))?.split('=')[1] 
                || process.env.GH_PAT ;
const BATCH_SIZE = 20;
const CHUNK_SIZE = 1900;

/**
 * 解析变更文件列表
 * 从命令行参数指定的JSON文件中读取GitHub Action的tj-actions/changed-files输出
 * @returns {Object|null} - 包含added、modified、deleted三个数组的对象，如果未提供则返回 null
 */
function parseChangedFiles() {
  // 从命令行参数获取JSON文件路径
  const jsonFilePath = process.argv.find(arg => arg.startsWith('--changed-files='))?.split('=')[1];
  
  if (!jsonFilePath) {
    console.log('📋 未提供变更文件列表，将扫描所有文件');
    return null;
  }
  
  try {
    // 读取并解析JSON文件
    const jsonContent = fs.readFileSync(jsonFilePath, 'utf-8');
    const changedData = JSON.parse(jsonContent);
    
    // 验证JSON格式
    if (!changedData || typeof changedData !== 'object') {
      console.error('❌ JSON文件格式错误：根节点必须是对象');
      return null;
    }
    
    const added = Array.isArray(changedData.added) ? changedData.added : [];
    const modified = Array.isArray(changedData.modified) ? changedData.modified : [];
    const deleted = Array.isArray(changedData.deleted) ? changedData.deleted : [];
    
    // 转换为相对于 CONTENT_DIR 的路径
    const normalizePath = (file) => {
      let relativePath = file;
      // 如果路径以 content/ 开头，移除前缀
      if (relativePath.startsWith(CONTENT_DIR + '/')) {
        relativePath = relativePath.substring(CONTENT_DIR.length + 1);
      }
      // 标准化路径分隔符
      return relativePath.replace(/\\/g, '/');
    };
    
    const result = {
      added: added.map(normalizePath),
      modified: modified.map(normalizePath),
      deleted: deleted.map(normalizePath)
    };
    
    const totalChanges = result.added.length + result.modified.length + result.deleted.length;
    console.log(`📋 检测到 ${totalChanges} 个变更文件:`);
    if (result.added.length > 0) {
      console.log(`   - 新增: ${result.added.length} 个文件`);
    }
    if (result.modified.length > 0) {
      console.log(`   - 修改: ${result.modified.length} 个文件`);
    }
    if (result.deleted.length > 0) {
      console.log(`   - 删除: ${result.deleted.length} 个文件`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ 读取变更文件失败:', error.message);
    console.log('📋 将扫描所有文件');
    return null;
  }
}

// 速率限制配置
const RATE_LIMIT_MAX_REQUESTS = 15; // 每分钟最大请求数
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 时间窗口（毫秒）
const REQUEST_DELAY_MS = RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX_REQUESTS; // 每次请求间隔（约4秒）

// 速率限制状态
let requestTimestamps = [];

/**
 * 检查并等待以满足速率限制
 */
async function enforceRateLimit() {
  const now = Date.now();
  
  // 移除超过时间窗口的请求记录
  requestTimestamps = requestTimestamps.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  
  // 如果已达到速率限制，等待直到有可用配额
  if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestRequest) + 100; // 额外缓冲100ms
    
    console.log(`⏳ 达到速率限制，等待 ${Math.ceil(waitTime / 1000)} 秒...`);
    await sleep(waitTime);
    
    // 重新清理过期记录
    const newNow = Date.now();
    requestTimestamps = requestTimestamps.filter(timestamp => newNow - timestamp < RATE_LIMIT_WINDOW_MS);
  }
  
  // 记录当前请求时间
  requestTimestamps.push(Date.now());
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 确保缓存目录存在
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log('📁 已创建缓存目录:', CACHE_DIR);
  }
}

/**
 * 加载缓存数据
 * @returns {Object} - 缓存对象，包含每个文件的元数据
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      console.log('💾 已加载缓存文件，包含', Object.keys(cacheData).length, '个文档记录');
      return cacheData;
    }
  } catch (error) {
    console.warn('⚠️  加载缓存失败:', error.message);
  }
  console.log('🆕 未找到缓存文件，将进行全量构建');
  return {};
}

/**
 * 保存缓存数据
 * @param {Object} cacheData - 要保存的缓存数据
 */
function saveCache(cacheData) {
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf-8');
    console.log('💾 已保存缓存文件到', CACHE_FILE);
  } catch (error) {
    console.error('❌ 保存缓存失败:', error.message);
  }
}

/**
 * 从旧的索引文件中提取向量数据（按URL组织）
 * @returns {Object} - 以URL为键的向量数据映射
 */
function loadOldIndexByUrl() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const indexData = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
      const urlMap = {};
      
      indexData.forEach(entry => {
        if (!urlMap[entry.url]) {
          urlMap[entry.url] = [];
        }
        urlMap[entry.url].push(entry);
      });
      
      console.log('📊 已从旧索引加载', Object.keys(urlMap).length, '个文档的向量数据');
      return urlMap;
    }
  } catch (error) {
    console.warn('⚠️  加载旧索引失败:', error.message);
  }
  console.log('🆕 未找到旧索引文件');
  return {};
}

/**
 * 获取所有现存的Markdown文件路径
 * @returns {Set} - 所有文件的相对路径集合
 */
function getAllFilePaths() {
  const filePaths = new Set();
  
  function walkDir(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      if (fs.statSync(fullPath).isDirectory()) {
        walkDir(fullPath);
      } else if (item.endsWith('.md')) {
        const relativePath = path.relative(CONTENT_DIR, fullPath).replace(/\\/g, '/');
        filePaths.add(relativePath);
      }
    }
  }
  
  walkDir(CONTENT_DIR);
  return filePaths;
}

async function getEmbeddings(texts) {
  // 执行速率限制检查
  await enforceRateLimit();
  
  try {
    const response = await fetch(EMBEDDING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_PAT}`,
      },
      body: JSON.stringify({
        input: texts,
        model: 'text-embedding-3-small',
      }),
    });
    
    // 处理速率限制错误
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || 60;
      console.warn(`⚠️  收到429错误，等待 ${retryAfter} 秒后重试...`);
      await sleep(retryAfter * 1000);
      return getEmbeddings(texts); // 递归重试
    }
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    // 判断data
    if (!data || !data.data || !data.data.length) {
      // 打印data
      console.log(data);
      throw new Error('Invalid response from OpenAI API');
    }
    return data.data.map(d => d.embedding);
  } catch (error) {
    console.error('❌ 获取嵌入向量失败:', error.message);
    throw error;
  }
}

/**
 * 按Markdown一级标题切割内容
 * @param {string} content - Markdown内容
 * @returns {string[]} - 切割后的块数组
 */
function splitByHeading(content) {
  // 使用正则表达式按一级标题分割
  const headingRegex = /^#\s+/m;
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 如果是一级标题且当前块不为空，保存当前块
    if (headingRegex.test(line) && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }
  
  // 添加最后一个块
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }
  
  // 过滤掉空块和过短的块
  return chunks.filter(chunk => chunk.trim().length > 0);
}

/**
 * 确保每个块不超过最大字符数
 * @param {string} text - 文本内容
 * @param {number} maxSize - 最大字符数
 * @returns {string[]} - 切割后的块数组
 */
function ensureMaxChunkSize(text, maxSize) {
  // 如果文本长度不超过限制，直接返回
  if (text.length <= maxSize) {
    return [text];
  }
  
  const chunks = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }
    
    // 在maxSize范围内寻找合适的切割点（优先在段落边界切割）
    let cutIndex = maxSize;
    
    // 尝试在段落边界切割（查找换行符）
    const lastNewline = remaining.lastIndexOf('\n\n', maxSize);
    if (lastNewline > maxSize * 0.5) {
      cutIndex = lastNewline;
    } else {
      // 如果没有找到合适的段落边界，在句子边界切割
      // 注意：lastIndexOf 不支持正则，这里简化处理，查找常见标点
      const punctuations = ['。', '.', '！', '!', '？', '?'];
      let lastPunct = -1;
      for (const p of punctuations) {
          const idx = remaining.lastIndexOf(p, maxSize);
          if (idx > lastPunct) lastPunct = idx;
      }
      
      if (lastPunct > maxSize * 0.5) {
        cutIndex = lastPunct + 1;
      }
    }
    
    // 提取当前块
    const chunk = remaining.substring(0, cutIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    // 更新剩余文本
    remaining = remaining.substring(cutIndex).trim();
  }
  
  return chunks.filter(chunk => chunk.length > 20);
}

/**
 * 扫描所有需要处理的文件
 * @param {Object} changedFiles - 变更文件对象，包含added、modified、deleted数组
 * @returns {Array} - 需要处理的文件信息数组
 */
function scanAllFiles(changedFiles) {
  const files = [];
  
  // 只处理新增和修改的文件
  const filesToProcess = new Set([...changedFiles.added, ...changedFiles.modified]);
  
  console.log(`📋 需要处理的文件数: ${filesToProcess.size}`);
  
  // 遍历需要处理的文件
  filesToProcess.forEach(relativePath => {
    const fullPath = path.join(CONTENT_DIR, relativePath);
    
    // 检查文件是否存在（删除的文件不需要处理）
    if (!fs.existsSync(fullPath)) {
      console.warn(`⚠️  文件不存在，跳过: ${relativePath}`);
      return;
    }
    
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const status = changedFiles.added.includes(relativePath) ? 'added' : 'modified';
      
      files.push({
        fullPath,
        relativePath,
        raw,
        status
      });
    } catch (error) {
      console.error(`❌ 读取文件失败 ${relativePath}:`, error.message);
    }
  });
  
  return files;
}

/**
 * 处理单个文件：切块并生成向量结构（不含embedding）
 * @param {Object} fileInfo - 文件信息
 * @returns {Array} - 条目数组
 */
function processFileStructure(fileInfo) {
  const { data: frontmatter, content } = matter(fileInfo.raw);
  const title = frontmatter.title || path.basename(fileInfo.fullPath, '.md');
  
  // 根据文件所在目录动态生成URL
  const urlPath = fileInfo.relativePath.replace(/\\/g, '/').replace(/\.md$/, '.html');
  const url = `/zh/${urlPath}/`;
  
  // 按一级标题切割
  const chunks = splitByHeading(content);
  
  // 对每个块进行处理
  const entries = [];
  chunks.forEach(chunk => {
    // 如果块超过CHUNK_SIZE字，继续切割
    const subChunks = ensureMaxChunkSize(chunk, CHUNK_SIZE);
    
    // 为每个子块添加标题前缀并添加到条目
    subChunks.forEach(subChunk => {
      const prefixedText = `【${title}】=>${subChunk}`;
      entries.push({ 
        title, 
        url, 
        text: prefixedText, 
        originalText: subChunk,
        embedding: null 
      });
    });
  });
  
  return entries;
}

async function main() {
  console.log('🚀 开始增量向量更新...\n');
  
  // 步骤1: 解析变更文件列表
  const changedFiles = parseChangedFiles();
  
  // 如果没有提供变更文件列表，直接退出
  if (!changedFiles) {
    console.log('⚠️  未提供变更文件列表，跳过向量数据处理');
    console.log('💡 提示: 请使用 --changed-files=<path> 参数指定变更文件JSON路径');
    process.exit(0);
  }
  
  // 步骤2: 加载缓存和旧索引
  const cache = loadCache();
  const oldIndexByUrl = loadOldIndexByUrl();
  
  // 步骤3: 扫描文件（根据是否有变更列表决定扫描范围）
  const filesToProcess = scanAllFiles(changedFiles);
  
  console.log(`📊 处理 ${filesToProcess.length} 个变更文件\n`);
  
  // 步骤4: 分类文件状态
  const filesToReuse = [];
  
  // 直接使用提供的删除文件列表
  const deletedPaths = changedFiles.deleted;
  if (deletedPaths.length > 0) {
    console.log(`🗑️  检测到 ${deletedPaths.length} 个已删除的文档，将从索引中移除`);
    console.log(`   删除文件:`, deletedPaths.slice(0, 10).join(', '), deletedPaths.length > 10 ? '...' : '');
  }
  
  // 对于未变更的文件，从缓存中复用
  Object.keys(cache).forEach(cachedPath => {
    // 如果文件不在新增、修改、删除列表中，可以复用
    const isInChangedList = 
      changedFiles.added.includes(cachedPath) || 
      changedFiles.modified.includes(cachedPath) || 
      changedFiles.deleted.includes(cachedPath);
    
    if (!isInChangedList) {
      const url = `/zh/${cachedPath.replace(/\\/g, '/').replace(/\.md$/, '.html')}/`;
      if (oldIndexByUrl[url]) {
        filesToReuse.push({
          relativePath: cachedPath,
          url,
          oldEntries: oldIndexByUrl[url]
        });
      }
    }
  });
  
  console.log(`\n📋 文件状态统计:`);
  console.log(`   - 需重新处理: ${filesToProcess.length} 个文件`);
  console.log(`   - 可复用向量: ${filesToReuse.length} 个文件`);
  console.log(`   - 已删除文件: ${changedFiles.deleted.length} 个文件`);
  console.log();
  
  // 步骤5: 处理需要重新处理的文件
  const allEntries = [];
  let processedCount = 0;
  
  if (filesToProcess.length > 0) {
    console.log('⚙️  开始处理变更的文件...\n');
    
    // 收集所有需要处理的条目
    const entriesToEmbed = [];
    
    for (const file of filesToProcess) {
      const entries = processFileStructure(file);
      entries.forEach(entry => {
        entriesToEmbed.push(entry);
      });
    }
    
    console.log(`📝 共生成 ${entriesToEmbed.length} 个文本块待嵌入\n`);
    
    // 分批获取嵌入向量
    for (let i = 0; i < entriesToEmbed.length; i += BATCH_SIZE) {
      const batch = entriesToEmbed.slice(i, i + BATCH_SIZE).map(e => e.text);
      const embeddings = await getEmbeddings(batch);
      
      // 将向量附加到条目
      embeddings.forEach((emb, idx) => {
        entriesToEmbed[i + idx].embedding = emb;
      });
      
      processedCount += embeddings.length;
      console.log(`✅ 嵌入进度: ${processedCount}/${entriesToEmbed.length}`);
    }
    
    // 添加到总条目列表
    allEntries.push(...entriesToEmbed);
    
    console.log(`\n✅ 完成 ${filesToProcess.length} 个文件的重新处理\n`);
  }
  
  // 步骤6: 复用未变化的文件向量
  if (filesToReuse.length > 0) {
    console.log('♻️  复用未变化文件的向量数据...\n');
    
    filesToReuse.forEach(file => {
      allEntries.push(...file.oldEntries);
    });
    
    console.log(`✅ 已复用 ${filesToReuse.length} 个文件的向量数据\n`);
  }
  
  // 步骤7: 写入新的索引文件
  console.log('💾 正在写入新的索引文件...\n');
  fs.writeFileSync(INDEX_FILE, JSON.stringify(allEntries, null, 2), 'utf-8');
  console.log(`🎉 索引生成完成，共 ${allEntries.length} 个段落。`);
  console.log(`📁 索引文件位置: ${INDEX_FILE}\n`);
  
  // 步骤8: 更新缓存（只保留现存文件的记录）
  const updatedCache = {};
  
  // 添加新处理的文件到缓存
  filesToProcess.forEach(file => {
    updatedCache[file.relativePath] = {
      lastUpdated: new Date().toISOString()
    };
  });
  
  // 添加复用的文件到缓存
  filesToReuse.forEach(file => {
    if (cache[file.relativePath]) {
      updatedCache[file.relativePath] = cache[file.relativePath];
    }
  });
  
  saveCache(updatedCache);
  
  // 统计信息
  console.log('\n📊 构建统计:');
  console.log(`   - 处理文件: ${filesToProcess.length} 个`);
  console.log(`   - 复用向量: ${filesToReuse.length} 个文件`);
  console.log(`   - 删除文档: ${changedFiles.deleted.length} 个文件`);
  console.log(`   - 总段落数: ${allEntries.length}`);
  console.log(`   - API调用批次: ${Math.ceil(processedCount / BATCH_SIZE)} 次`);
  
  console.log('\n✅ 增量更新完成！\n');
}

main().catch(error => {
  console.error('❌ 构建失败:', error);
  process.exit(1);
});














