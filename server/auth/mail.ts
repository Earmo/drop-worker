import nodemailer from "nodemailer";
import type { MailMessage, MailSender } from "../../api/platform";
import type { LocalAuthConfig } from "./local-auth";

/** Node.js SMTP adapter；认证流程只依赖 MailSender。 */
export class NodeSmtpMailSender implements MailSender {
  private readonly transport: nodemailer.Transporter;

  constructor(config: NonNullable<LocalAuthConfig["smtp"]>) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail(message);
  }

  close(): void {
    this.transport.close();
  }
}
