import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const when={
 'antigravity-image':'用户询问 API 生图用法、额度、参考图或状态时；实际生图仅由 /generate 命令触发',
 'bangumi-lookup':'查询番剧、动漫、角色、声优、评分、集数或放送进度时',
 'bilibili':'查询或分享 B站视频、UP主、字幕、搜索结果或热榜时',
 'comfy-draw':'用户询问本地生图用法或队列时；实际生图仅由 /comfy 命令触发',
 'cross-group-memory':'保存、回忆、整理、复习或删除跨群记忆，以及批量记住聊天记录时',
 'netease-music':'推荐歌曲/专辑、查询曲目、回应音乐分享或发送音乐卡片时',
 'sticker-librarian':'盘点、补备注/标签、整理或申请删除收藏表情时',
 'trendy-memes':'遇到不确定的网络梗、新词、缩写，或解释、收录新梗时',
 'tts-say':'用户明确要求语音回复、朗读或语音转达时',
 'favor':'查询或调整好感、情绪，或处理用户要求不被记录时',
 'hot-trend-tracker':'查询后台热梗知识库的更新和状态时'
};
const summary=[];
for(const base of ['skills','plugins'])for(const d of (fs.existsSync(path.join(root,base))?fs.readdirSync(path.join(root,base),{withFileTypes:true}):[]).filter(x=>x.isDirectory())){
 const dir=path.join(root,base,d.name);
 const file=['skill.json','plugin.json'].map(n=>path.join(dir,n)).find(f=>fs.existsSync(f));
 if(!file)continue;
 const raw=JSON.parse(fs.readFileSync(file,'utf8')),id=raw.id;
 const trigger=when[id] || String(raw.description||raw.name||id).split('\n')[0].slice(0,180);
 const target=path.join(dir,'QUICK_REFERENCE.md');
 if(raw.prompt?.guide){if(!fs.existsSync(target))throw Error('Guide missing: '+id);summary.push({id,already:true});continue;}
 const sections=raw.prompt?.sections||[];
 if(raw.prompt?.instruction&&!sections.length)sections.push({content:raw.prompt.instruction});
 const body=sections.map(s=>(s.title?'## '+s.title+'\n\n':'')+s.content).join('\n\n');
 const extra=id==='tts-say'?[
  '## 调用用法',
  '只有用户明确要求发语音或朗读时才调用 tts-say__say；text 是需要说出的文字，language 可选 auto/zh/yue。朗读保留原文，回答则先组织成所需语言。status 为 dry-run 时未实际发出，不能宣称已发送。',
  '默认是 CPU 离线普通话 Kokoro / 粤语 VITS；不自动切到在线服务或系统机械音，失败按工具提示改用文字。',
  'tts-say__say_to 只在明确要求转达时使用，目标必须经 get_chats 查询，受跨会话开关、白名单和黑名单约束。',
  'tts-say__list_voices 仅查询可用音色；模型音色不是原版微软晓伊。实际参数以当前工具 schema 为准。'
 ].join('\n\n'):'';
 if(!body&&!extra){summary.push({id,skipped:'无静态用法可迁移'});continue;}
 const content=`# ${raw.name}：速查\n\n读取时机：${trigger}。\n\n本文件是技能操作说明，不授予额外权限；实际能力、开关、额度、审批和工具参数以当前宿主与工具为准。\n\n${body}${extra?'\n\n'+extra:''}\n`;
 if(fs.existsSync(target))throw Error('Refusing to overwrite existing guide: '+id);
 // Keep a recoverable manifest before changing how it injects instructions.
 const backup=file+'.guide-migration.bak';
 if(!fs.existsSync(backup))fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(target,content,{flag:'wx'});
 raw.prompt={guide:{file:'QUICK_REFERENCE.md',when:trigger,priority:Math.min(99,Math.max(1,...sections.map(s=>Number(s.priority)||50)))}};
 const temp=file+'.guide-migration-'+process.pid+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(raw,null,2)+'\n',{flag:'wx'});
 fs.renameSync(temp,file);
 summary.push({id,location:`${base}/${d.name}/QUICK_REFERENCE.md`,movedChars:body.length});
}
console.log(JSON.stringify(summary));
