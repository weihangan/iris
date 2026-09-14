// PMX 加载器入口（Phase 3 Task 3.1）
// 职责：作为 PMX 加载/解析的统一入口，re-export pmx-parser 的所有功能
// 审计脚本期望此文件存在作为 PMX 加载器入口
// 实际解析逻辑在 pmx-parser.ts 中（纯解析，不依赖 Node.js Buffer，可在 renderer 中使用）
export * from './pmx-parser';
