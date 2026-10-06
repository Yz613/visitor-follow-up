import type { EmailSender, SendEmailPayload, SendEmailResult } from './interface';

export class ResendEmailSender implements EmailSender {
  private defaultApiKey?: string;

  constructor(defaultApiKey?: string) {
    this.defaultApiKey = defaultApiKey;
  }

  async send(payload: SendEmailPayload, apiKey?: string): Promise<SendEmailResult> {
    const key = apiKey || this.defaultApiKey;
    if (!key) {
      return {
        success: false,
        error: 'No Resend API key provided (neither per-site nor globally configured).',
      };
    }

    const headers: Record<string, string> = {
      'List-Unsubscribe': `<${payload.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      ...(payload.customHeaders || {}),
    };

    const resendBody: Record<string, any> = {
      from: `${payload.fromName} <${payload.fromEmail}>`,
      to: [payload.to],
      subject: payload.subject,
      text: payload.bodyText,
      headers,
    };

    if (payload.replyTo) {
      resendBody.reply_to = payload.replyTo;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendBody),
      });

      const data: any = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg = data?.message || data?.error || `HTTP ${response.status} ${response.statusText}`;
        return {
          success: false,
          error: errorMsg,
        };
      }

      return {
        success: true,
        messageId: data?.id || undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Network error while contacting Resend API',
      };
    }
  }
}
