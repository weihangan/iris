/**
 * 表情包调用服务
 *
 * 目录约定：character/<id>/表情包/<大范围>-<细分>.<ext>
 *   - 大范围（"-"前）：应用场景的大类，如 喜欢/害羞/开心/搞怪/伤心/惊讶/鼓励/吃瓜...
 *   - 细分（"-"后）：  该场景下的具体画面，如 冒爱心/偷偷看/小骄傲...
 *
 * 命名规则要求所有表情包都必须含 "-"，否则视为"大范围"缺失，跳过。
 * AI 通过在回复中写入 [表情包:大范围-细分] 标记来调用对应图片，
 * 前端解析标记后渲染为图片气泡。
 */
const fs = require('fs');
const path = require('path');

const { CHARACTER_DIR } = require('./appPaths');
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const PROMPT_EXCLUDED_STICKER_DETAILS = new Set(['菲比丘比']);

/**
 * 列出某角色的所有可用表情包
 * @param {string} characterId
 * @returns {Array<{name:string, category:string, detail:string, filename:string, ext:string}>}
 */
function listStickers(characterId) {
  if (!characterId) return [];
  const dir = path.join(CHARACTER_DIR, String(characterId), '表情包');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const result = [];
  for (const filename of fs.readdirSync(dir)) {
    const ext = path.extname(filename).toLowerCase();
    if (!IMG_EXTS.includes(ext)) continue;
    const base = path.basename(filename, ext);
    const dashIdx = base.indexOf('-');
    if (dashIdx <= 0) continue; // 必须含 "-"，且不在开头
    const category = base.slice(0, dashIdx).trim();
    const detail = base.slice(dashIdx + 1).trim();
    if (!category) continue;
    result.push({
      name: base,            // 大范围-细分（无扩展名）
      category,              // 大范围
      detail,                // 细分
      filename,              // 完整文件名（含扩展名）
      ext,
    });
  }
  return result;
}

/**
 * 按"大范围"分组，返回 { category: [细分级表] }，供 AI 快速查阅
 */
function listStickersGrouped(characterId) {
  const list = listStickers(characterId);
  const groups = {};
  for (const s of list) {
    if (!groups[s.category]) groups[s.category] = [];
    groups[s.category].push(s.detail);
  }
  return groups;
}

/**
 * 获取表情包图片的绝对路径（用于 sendFile）
 * @returns {string|null}
 */
function getStickerPath(characterId, filename) {
  if (!characterId || !filename) return null;
  // 防路径穿越：filename 不能含 / \ ..
  if (/[\\/]/.test(filename) || filename.includes('..')) return null;
  const dir = path.join(CHARACTER_DIR, String(characterId), '表情包');
  const filePath = path.join(dir, filename);
  // 解析后必须仍在表情包目录内
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  if (resolved.indexOf(resolvedDir + path.sep) !== 0) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

/**
 * 构建注入到 systemPrompt 的"表情包使用说明"文本
 * 仅当角色有表情包时才返回非空字符串
 */
function buildStickerPrompt(characterId) {
  const groups = listStickersGrouped(characterId);
  const categories = Object.keys(groups);
  if (categories.length === 0) return '';

  // 列出可用表情包（大范围-细分）
  const lines = [];
  for (const cat of categories) {
    const details = groups[cat].filter(detail => !PROMPT_EXCLUDED_STICKER_DETAILS.has(detail));
    if (details.length === 0) continue;
    lines.push(`  - ${cat}: ${details.join('、')}`);
  }
  if (lines.length === 0) return '';
  const stickerList = lines.join('\n');

  return `
【表情包系统（重要）】
当前角色已配置表情包，可在回复中通过标记调用：[表情包:大范围-细分]
调用示例：[表情包:喜欢-冒爱心] 或 [表情包:害羞-偷偷看]

可用表情包清单（格式 大范围-细分）：
${stickerList}

使用规则（必须严格遵守，违反任何一条都是错误）：
1. 低频但要真实使用：通常每 8-12 条助手回复使用 1 个表情包。一条回复最多 1 个；情绪明显匹配且间隔允许时，可以主动使用，不要永远不用。
2. 绝不连续：绝对不能在连续两条回复中都发表情包。如果上一条回复已经有表情包，这一条绝对不能有。
3. 场合匹配：表情包的"大范围"必须与当前对话情绪一致——开心时用"开心/喜欢"类，难过时用"伤心"类，搞笑时用"搞怪"类，绝不能错用。
4. 文字优先：表情包只是偶尔的点缀，回复必须有充分的文字内容，不能只发表情包，不能为了发表情包而发。
5. 调用格式严格为 [表情包:大范围-细分]，"大范围"和"细分"必须与清单完全一致（连字符号用半角"-"）。
6. 若无合适表情包就不使用。日常问候和简单对话可以偶尔使用贴合语气的表情包，但连续短回复仍应克制。
7. 表情包标记放在回复末尾或独立一行，不要塞在句子中间。
`;
}

module.exports = {
  listStickers,
  listStickersGrouped,
  getStickerPath,
  buildStickerPrompt,
};
