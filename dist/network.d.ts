/** Addresses that must never be fetched from a message-supplied remote URL. */
export declare function isPublicAddress(raw: string): boolean;
export declare function validateHttpUrl(value: string): URL;
export declare function boundedResponse(response: Response, maxBytes: number): Promise<Buffer>;
/** DNS answers are checked and pinned to the socket; a second DNS lookup cannot rebind it. */
export declare function downloadPublicUrl(value: string, options: {
    allowedOrigins: string[];
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
}): Promise<{
    bytes: Buffer;
    contentType: string;
}>;
