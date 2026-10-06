export interface WebhookEventPayload {
  event: 'draft.created' | 'email.sent' | 'person.unsubscribed';
  siteId: string;
  timestamp: string;
  data: Record<string, any>;
}

export async function dispatchWebhook(
  webhookUrl?: string | null,
  webhookSecret?: string | null,
  eventData?: WebhookEventPayload
): Promise<{ success: boolean; error?: string }> {
  if (!webhookUrl || !eventData) {
    return { success: true }; // No webhook configured, no-op
  }

  try {
    const payloadString = JSON.stringify(eventData);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'visitor-follow-up-webhook/1.0',
    };

    if (webhookSecret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadString));
      const bytes = new Uint8Array(signatureBuffer);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      headers['X-Visitor-Signature'] = `sha256=${hex}`;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: payloadString,
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Webhook returned HTTP ${res.status} ${res.statusText}`,
      };
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: `Webhook delivery failed: ${err?.message || String(err)}`,
    };
  }
}
