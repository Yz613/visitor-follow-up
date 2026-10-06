import type { EmailSender, SendEmailPayload, SendEmailResult } from './interface';

export class MockEmailSender implements EmailSender {
  public sentEmails: Array<{ payload: SendEmailPayload; apiKey?: string }> = [];
  public shouldFail = false;
  public failureMessage = 'Simulated email send failure';

  async send(payload: SendEmailPayload, apiKey?: string): Promise<SendEmailResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failureMessage };
    }
    this.sentEmails.push({ payload, apiKey });
    return {
      success: true,
      messageId: `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    };
  }

  clear(): void {
    this.sentEmails = [];
    this.shouldFail = false;
  }
}
