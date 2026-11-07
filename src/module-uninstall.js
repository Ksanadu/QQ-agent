import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// These legacy modules store their owned data outside the module directory.
const ownedData = {
  'antigravity-image': ['antigravity-image'], 'comfy-draw': ['comfy-draw'],
  'cross-group-memory': ['memory-curve'], 'tts-say': ['tts-cache', 'tts-say-state.json', 'tts-neural']
};
function child(root, target, direct = false) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || (direct && path.dirname(rel) !== '.')) throw Error('模块路径超出允许范围');
  // Never follow junctions / symlinks while moving or deleting module data.
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('不支持卸载符号链接目录');
  }
  return target;
}
export function uninstallModuleFiles({id, clearData = false, root, dataDir, manager, getConfig, updateConfig}) {
  const skill = manager.registry.get(id);
  if (!skill) throw Error('模块不存在或已经卸载');
  const dir = path.resolve(skill.dir);
  const kind = skill.kind === 'plugin' ? 'plugins' : 'skills';
  const base = path.resolve(root, kind);
  child(base, dir, true);
  if (fs.realpathSync(base) !== base || fs.realpathSync(dir) !== dir) throw Error('模块路径包含重定向');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw Error('模块 ID 无效');
  const backups = child(dataDir, path.join(dataDir, 'module-backups', kind, path.basename(dir)));
  const dataPaths = [path.join(dataDir, kind, id), ...(ownedData[id] || []).map(p => path.join(dataDir, p))].map(p => child(dataDir, p));
  const backupPath = path.join(backups, crypto.randomUUID(), 'module');
  // Stage the entire directory first: unknown module-local files may be user data.
  fs.mkdirSync(path.dirname(backupPath), {recursive:true});
  const previous = getConfig().skills || {};
  updateConfig({skills:{[id]:{...previous[id], enabled:false}}});
  manager.unregister(id, {reason:'uninstall'});
  try {
    try { fs.renameSync(dir, backupPath); }
    catch(e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(dir, backupPath, {recursive:true,errorOnExist:true,force:false});
      fs.rmSync(dir, {recursive:true,force:true});
    }
  }
  catch (e) { throw Error(`模块已停用，但文件移除失败：${e.message}`); }
  if (clearData) {
    for (const target of [...dataPaths, backups]) if (fs.existsSync(target)) fs.rmSync(target, {recursive:true,force:true});
    const next = {...getConfig().skills}; delete next[id];
    updateConfig({skills:{__replace__:next}});
  }
  return {ok:true,id,clearData,backupPath:clearData?null:backupPath};
}
