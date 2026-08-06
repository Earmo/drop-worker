interface Env {
  AUTH_SESSION_SECRET: string;
  AUTH_EMAIL_PROVIDER: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURE: string;
  SMTP_FROM: string;
  SMTP_TIMEOUT_MS: string;
  SMTP_USERNAME: string;
  SMTP_PASSWORD: string;
}

declare namespace Cloudflare {
  interface Env {
    AUTH_SESSION_SECRET: string;
    AUTH_EMAIL_PROVIDER: string;
    SMTP_HOST: string;
    SMTP_PORT: string;
    SMTP_SECURE: string;
    SMTP_FROM: string;
    SMTP_TIMEOUT_MS: string;
    SMTP_USERNAME: string;
    SMTP_PASSWORD: string;
  }
}
