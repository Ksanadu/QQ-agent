import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const definitions=[
  ['core-stickers','发表情、贴表情、拍一拍或整理表情库时'],
  ['core-context','查询历史、引用对象、连续任务、记忆或跨会话发送时'],
  ['core-media','查看、收藏、发送图片，读语音/视频/合并转发或发视频卡片时'],
  ['core-web','查实时信息、新梗、不确定事实或网页内容时']
];
const guides=new Map(definitions.map(([id,when])=>[id,Object.freeze({
  coreGuide:true, guideFile:`${id}.md`, dir:path.join(root,'doc','core-guides'),
  manifest:{id,name:id,prompt:{guide:{file:`${id}.md`,when,priority:50}}}
})]));
export const getCoreGuide=id=>guides.get(id)||null;
export function coreGuideIndexes(){return [...guides.values()].map(s=>({
  id:s.manifest.id,guideId:s.manifest.id,when:s.manifest.prompt.guide.when,
  location:`doc/core-guides/${s.guideFile}`,isGuideIndex:true,priority:50,content:''
}));}
