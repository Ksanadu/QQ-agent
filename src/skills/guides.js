import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCoreGuide } from '../core-guides.js';

export const GUIDE_FILE = 'QUICK_REFERENCE.md';
const MAX_GUIDE_BYTES = 64 * 1024;
// Scoped to a single run's ctx, never shared between chats or retries.
const readByContext = new WeakMap();

export function guideLocation(skill) {
  if(skill.coreGuide) return `doc/core-guides/${skill.guideFile}`;
  const relative = String(skill.relDir || '').replaceAll('\\', '/');
  const dir = /^(skills|plugins)\/[a-zA-Z0-9_-]+$/.test(relative)
    ? relative : `${skill.kind === 'plugin' ? 'plugins' : 'skills'}/${skill.manifest.id}`;
  return `${dir}/${GUIDE_FILE}`;
}

function loadGuide(manager, id, context) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('技能 ID 无效');
  const skill = getCoreGuide(id) || manager.registry.get(id);
  if (!skill || (!skill.coreGuide && !manager.isActive(id, context.skillContext || context).active)) throw new Error('技能未加载、已关闭或当前不可用');
  const guide = skill.manifest.prompt?.guide;
  const filename=skill.coreGuide?skill.guideFile:GUIDE_FILE;
  if (!guide || guide.file !== filename || !skill.dir) throw new Error('该技能未提供速查文档');
  let dir, file, fd;
  try {
    dir = fs.realpathSync(skill.dir);
    file = fs.realpathSync(path.join(dir, filename));
    const relative = path.relative(dir, file);
    if (relative !== filename) throw new Error('速查文档不在技能目录内');
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_GUIDE_BYTES) throw new Error('速查文档为空或超过 64 KiB');
    // Bounded read even if an extension concurrently replaces/grows its guide.
    const buffer = Buffer.alloc(MAX_GUIDE_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size === 0 || size > MAX_GUIDE_BYTES) throw new Error('速查文档为空或超过 64 KiB');
    const bytes = buffer.subarray(0, size);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (!content) throw new Error('速查文档为空');
    return { skill, content, signature: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    // Do not expose filesystem paths in a model-visible failure.
    if (error?.code === 'ENOENT') throw new Error('速查文档不存在，请管理员补齐');
    if (error instanceof TypeError) throw new Error('速查文档不是有效 UTF-8');
    if (error?.code) throw new Error('速查文档读取失败，请管理员检查');
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readSkillGuide(manager, context, id) {
  const result = loadGuide(manager, id, context);
  let read = readByContext.get(context);
  if (!read) { read = new Map(); readByContext.set(context, read); }
  read.set(id, { skill: result.skill, signature: result.signature });
  return { skillId: id, location: guideLocation(result.skill), content: result.content };
}

export function requireSkillGuide(manager, context, skillId) {
  const skill = manager.registry.get(skillId);
  if (!skill?.manifest.prompt?.guide) return;
  const current = loadGuide(manager, skillId, context);
  const previous = readByContext.get(context)?.get(skillId);
  if (!previous || previous.skill !== skill || previous.signature !== current.signature) {
    throw new Error(`请先调用 read_skill_guide({"skillId":"${skillId}"}) 读取当前速查文档，再使用该技能；文档更新后需重读。`);
  }
}
