// Email sender adapter interface

export interface SendEmailPayload {
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  subject: string;
  bodyText: string;
  unsubscribeUrl: string;
  customHeaders?: Record<string, string>;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailSender {
  send(payload: SendEmailPayload, apiKey?: string): Promise<SendEmailResult>;
}
