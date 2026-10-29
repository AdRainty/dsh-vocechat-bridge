export type Destination = { kind: 'user' | 'group'; id: number };
export type IncomingAttachment = { kind: 'image' | 'audio' | 'file'; path: string; name: string; mime: string; size?: number };
export type IncomingMessage = {
  id: string; senderId: number; destination: Destination; timestamp: number;
  text: string; attachments: IncomingAttachment[];
};
export type PreparedAttachment = IncomingAttachment & { localPath?: string; transcript?: string; error?: string };
export type PreparedMessage = Omit<IncomingMessage, 'attachments'> & { attachments: PreparedAttachment[] };
export type OutgoingAttachment = { kind: 'image' | 'audio' | 'file'; path?: string; url?: string; name?: string; mime?: string };
export type OutboundMessage = { text?: string; format?: 'plain' | 'markdown'; attachments?: OutgoingAttachment[]; replyTo?: number };
export interface SessionPort {
  run(messages: PreparedMessage[], signal: AbortSignal): Promise<{ text?: string; sent?: boolean; quiet?: boolean }>;
  dispose?(): void;
}
export type CredentialResolver = (ref: string) => Promise<string | undefined>;
export interface Logger { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void }
