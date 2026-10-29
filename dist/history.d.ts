import type { ConversationHistory, Destination, HistoryMessage } from './types.ts';
/** Keep the newest records within one JSON character budget, including metadata. */
export declare function boundHistory(destination: Destination, messages: HistoryMessage[], requested: number, maxChars: number): ConversationHistory;
export declare function historyContent(history: ConversationHistory): string;
