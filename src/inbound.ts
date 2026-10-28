import type { IncomingMessage } from './types.ts';

function id(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function normalizeWebhook(value: unknown): IncomingMessage | undefined {
  if (!value || typeof value !== 'object') throw new Error('INVALID_EVENT');
  const p = value as Record<string, any>;
  if (!id(p.mid) || !id(p.from_uid) || !p.target || typeof p.target !== 'object') throw new Error('INVALID_EVENT');
  if (id(p.target.gid) === id(p.target.uid)) throw new Error('INVALID_TARGET');
  const d = p.detail;
  if (!d || typeof d !== 'object') throw new Error('INVALID_DETAIL');
  if (!['normal', 'reply'].includes(d.type)) return undefined;
  if (typeof d.content !== 'string' || typeof d.content_type !== 'string') throw new Error('INVALID_CONTENT');
  const message: IncomingMessage = {
    id: String(p.mid), senderId: p.from_uid,
    destination: p.target.gid ? {kind:'group', id:p.target.gid} : {kind:'user',id:p.from_uid},
    timestamp: typeof p.created_at === 'number' && Number.isFinite(p.created_at) ? p.created_at : Date.now(),
    text: '', attachments: [],
  };
  if (['text/plain','text/markdown'].includes(d.content_type)) message.text = d.content;
  else if (['vocechat/file','vocechat/audio'].includes(d.content_type)) {
    const props = d.properties;
    if (!props || typeof props !== 'object' || typeof props.content_type !== 'string' || !d.content) throw new Error('INVALID_ATTACHMENT');
    const mime = props.content_type.toLowerCase().split(';')[0];
    message.attachments.push({
      kind: d.content_type === 'vocechat/audio' || mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : 'file',
      path: d.content, mime, name: typeof props.name === 'string' ? props.name : 'attachment',
      size: Number.isSafeInteger(props.size) && props.size >= 0 ? props.size : undefined,
    });
  } else return undefined;
  return message;
}
