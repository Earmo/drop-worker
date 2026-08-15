interface Env {
  AUTH_SESSION_SECRET: string;
  OWNER_EMAIL: string;
  AUTH_FROM_NAME: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURE: string;
  SMTP_FROM: string;
  SMTP_TIMEOUT_MS: string;
  SMTP_USERNAME: string;
  SMTP_PASSWORD: string;
  PUBLIC_URL: string;
  SHARING_ENABLED: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_URL: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    AUTH_SESSION_SECRET: string;
    OWNER_EMAIL: string;
    AUTH_FROM_NAME: string;
    SMTP_HOST: string;
    SMTP_PORT: string;
    SMTP_SECURE: string;
    SMTP_FROM: string;
    SMTP_TIMEOUT_MS: string;
    SMTP_USERNAME: string;
    SMTP_PASSWORD: string;
    PUBLIC_URL: string;
    SHARING_ENABLED: string;
    R2_ACCOUNT_ID: string;
    R2_BUCKET_NAME: string;
    R2_PUBLIC_URL: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}
