// Lightweight Visitor Follow-Up client snippet (< 4KB minified)
// Usable via <script src=".../vf.js" data-site="..."> or import vf from 'visitor-follow-up'

export interface VFConfig {
  siteId: string;
  endpoint?: string;
  autoPageview?: boolean;
  autoHookForms?: boolean;
}

export interface IdentifyTraits {
  name?: string;
  company?: string;
  companyDomain?: string;
  role?: string;
  [key: string]: any;
}

class VisitorFollowUp {
  private siteId: string | null = null;
  private endpoint: string = '';
  private anonymousId: string = '';
  private identifiedEmail: string | null = null;
  private initialized = false;

  constructor() {
    this.anonymousId = this.getOrCreateAnonymousId();
  }

  public init(config: VFConfig): void {
    this.siteId = config.siteId;
    this.endpoint = (config.endpoint || '').replace(/\/+$/, '');
    this.initialized = true;

    if (config.autoPageview !== false && typeof window !== 'undefined') {
      this.page();
      this.setupSpaListener();
    }

    if (config.autoHookForms !== false && typeof window !== 'undefined') {
      this.hookForms();
    }
  }

  public identify(
    email: string,
    traits: IdentifyTraits = {},
    options?: { source?: string; notes?: string; companyName?: string; companyDomain?: string }
  ): void {
    if (!email) return;
    const cleanEmail = email.trim().toLowerCase();
    this.identifiedEmail = cleanEmail;

    this.send('/v1/identify', {
      email: cleanEmail,
      anonymous_id: this.anonymousId,
      traits,
      email_source: options?.source || 'browser_snippet',
      notes: options?.notes,
      company: options?.companyName || traits.company,
      company_domain: options?.companyDomain || traits.companyDomain,
    });
  }

  public track(eventName: string, properties: Record<string, any> = {}): void {
    if (!eventName) return;

    this.send('/v1/events', {
      email: this.identifiedEmail,
      anonymous_id: this.anonymousId,
      event: eventName,
      properties,
      url: typeof window !== 'undefined' ? window.location.href : null,
      path: typeof window !== 'undefined' ? window.location.pathname + window.location.hash : null,
      referrer: typeof document !== 'undefined' ? document.referrer : null,
      timestamp: new Date().toISOString(),
    });
  }

  public page(properties: Record<string, any> = {}): void {
    if (typeof window === 'undefined') return;

    this.track('page_view', {
      title: document.title,
      url: window.location.href,
      path: window.location.pathname + window.location.hash,
      referrer: document.referrer || null,
      ...properties,
    });
  }

  public conversion(
    conversionType: string,
    amount?: number,
    isCustomer = true,
    properties: Record<string, any> = {}
  ): void {
    if (!this.identifiedEmail) return;

    this.send('/v1/conversions', {
      email: this.identifiedEmail,
      conversion_type: conversionType,
      amount: amount || 0,
      is_customer: isCustomer,
      properties,
    });
  }

  public reset(): void {
    this.identifiedEmail = null;
    this.anonymousId = this.generateId();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('vf_anon_id', this.anonymousId);
    }
  }

  private send(path: string, payload: Record<string, any>): void {
    const fullUrl = `${this.endpoint}${path}`;
    const data = {
      site_id: this.siteId,
      ...payload,
    };

    const jsonString = JSON.stringify(data);

    // Prefer fetch with keepalive; fallback to sendBeacon or normal fetch
    try {
      if (typeof fetch === 'function') {
        fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.siteId ? { 'X-Site-Key': this.siteId } : {}),
          },
          body: jsonString,
          keepalive: true,
          mode: 'cors',
        }).catch(() => {
          // Silent catch to prevent impacting host app
        });
      } else if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const blob = new Blob([jsonString], { type: 'application/json' });
        navigator.sendBeacon(fullUrl, blob);
      }
    } catch {
      // ignore network errors
    }
  }

  private getOrCreateAnonymousId(): string {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('vf_anon_id');
      if (stored) return stored;
      const created = this.generateId();
      localStorage.setItem('vf_anon_id', created);
      return created;
    }
    return this.generateId();
  }

  private generateId(): string {
    return 'anon_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
  }

  private setupSpaListener(): void {
    if (typeof window === 'undefined' || !window.history) return;

    const notify = () => {
      setTimeout(() => this.page(), 50);
    };

    const origPush = window.history.pushState;
    if (origPush) {
      window.history.pushState = function (...args) {
        origPush.apply(this, args);
        notify();
      };
    }

    const origReplace = window.history.replaceState;
    if (origReplace) {
      window.history.replaceState = function (...args) {
        origReplace.apply(this, args);
        notify();
      };
    }

    window.addEventListener('popstate', notify);
  }

  /**
   * Auto-hook forms with data-vf-form or data-vf-auto-hook attribute
   */
  public hookForms(): void {
    if (typeof document === 'undefined') return;

    const hook = () => {
      const forms = document.querySelectorAll<HTMLFormElement>('form[data-vf-form], form[data-vf-auto-hook]');
      forms.forEach((form) => {
        if ((form as any).__vf_hooked) return;
        (form as any).__vf_hooked = true;

        form.addEventListener('submit', () => {
          try {
            const formData = new FormData(form);
            let emailValue: string | null = null;
            const traits: Record<string, any> = {};

            formData.forEach((val, key) => {
              const strVal = String(val).trim();
              if (
                key.toLowerCase().includes('email') ||
                (typeof strVal === 'string' && strVal.includes('@') && strVal.includes('.'))
              ) {
                if (!emailValue) emailValue = strVal;
              } else {
                traits[key] = strVal;
              }
            });

            if (emailValue) {
              const formSource = form.getAttribute('data-vf-source') || form.id || form.name || 'form_submission';
              this.identify(emailValue, traits, { source: `form:${formSource}` });
            }
          } catch {
            // ignore form parse errors
          }
        });
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', hook);
    } else {
      hook();
    }
  }
}

// Global instance
export const vf = new VisitorFollowUp();

// Browser Auto-Initialization if loaded via <script>
if (typeof window !== 'undefined') {
  const currentScript = document.currentScript as HTMLScriptElement | null;
  if (currentScript) {
    const siteId = currentScript.getAttribute('data-site');
    const endpoint = currentScript.getAttribute('data-endpoint') || new URL(currentScript.src).origin;
    if (siteId) {
      vf.init({ siteId, endpoint });
    }
  }

  // Support command queuing before load: window.vf = window.vf || []; window.vf.push(['identify', ...])
  const win = window as any;
  const queue = win.vf && Array.isArray(win.vf.q) ? win.vf.q : [];
  win.vf = vf;

  for (const item of queue) {
    if (Array.isArray(item)) {
      const [method, ...args] = item;
      if (typeof (vf as any)[method] === 'function') {
        (vf as any)[method](...args);
      }
    }
  }
}

export default vf;
