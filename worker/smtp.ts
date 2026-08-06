type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  timeoutMs: number;
};

type SmtpMessage = {
  from: string;
  to: string;
  raw: string;
};

type SmtpResponse = {
  code: number;
  lines: string[];
};

const encoder = new TextEncoder();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  // Socket API 本身不会替每个 SMTP 阶段提供统一超时；这里把连接读写都包在同一个取消计时器内。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function base64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function supports(lines: string[], capability: string): boolean {
  // EHLO 的多行响应第一行带状态码，后续行是 capability；忽略参数只匹配能力名称。
  const target = capability.toLocaleUpperCase();
  return lines.some((line) => {
    const value = line.slice(4).trim().toLocaleUpperCase();
    return value === target || value.startsWith(`${target} `) || value.startsWith(`${target}=`);
  });
}

class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
    private readonly host: string,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        const chunk = await withTimeout(this.reader.read(), this.timeoutMs, "SMTP 服务器响应超时");
        if (chunk.done) throw new Error("SMTP 服务器提前关闭连接");
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        if (this.buffer.length > 64 * 1024) throw new Error("SMTP 服务器响应过大");
        continue;
      }
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (match?.[2] === " ") {
        // SMTP 多行响应用 "250-" 继续、"250 " 结束；只在结束行返回给调用方。
        return { code: Number(match[1]), lines };
      }
    }
  }

  async command(command: string): Promise<SmtpResponse> {
    await withTimeout(this.writer.write(encoder.encode(`${command}\r\n`)), this.timeoutMs, "SMTP 写入超时");
    return this.readResponse();
  }

  async writeData(raw: string): Promise<SmtpResponse> {
    // DATA 阶段需要 CRLF，并按 SMTP dot-stuffing 规则转义以点开头的正文行。
    const normalized = raw.replace(/\r?\n/g, "\r\n");
    const stuffed = normalized
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    const payload = stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
    await withTimeout(
      this.writer.write(encoder.encode(`${payload}.\r\n`)),
      this.timeoutMs,
      "SMTP 邮件内容写入超时",
    );
    return this.readResponse();
  }

  upgradeToTls(): void {
    // STARTTLS 会替换底层 socket；先释放旧 reader/writer，再为加密连接重新获取锁。
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls({ expectedServerHostname: this.host });
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = "";
  }

  async close(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.socket.close().catch(() => undefined);
  }
}

function expect(response: SmtpResponse, codes: number[], context: string): void {
  if (codes.includes(response.code)) return;
  throw new Error(`${context}失败（SMTP ${response.code}）`);
}

export async function sendSmtpMessage(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  // Workers Socket 不允许连接 25 端口；支持 465/994 隐式 TLS 或 587 明文后升级 STARTTLS。
  if (config.port === 25) throw new Error("Cloudflare Workers 禁止连接 SMTP 25 端口，请使用 465、587 或 994");
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? "on" : "starttls", allowHalfOpen: false },
  );
  const session = new SmtpSession(socket, config.timeoutMs, config.host);
  try {
    // 标准 SMTP 流程：握手 -> EHLO ->（可选）STARTTLS -> 重新 EHLO -> 认证 -> 投递。
    expect(await session.readResponse(), [220], "SMTP 握手");
    let response = await session.command("EHLO drop-worker");
    expect(response, [250], "SMTP EHLO");

    if (!config.secure) {
      if (!supports(response.lines, "STARTTLS")) throw new Error("SMTP 服务器不支持 STARTTLS");
      expect(await session.command("STARTTLS"), [220], "SMTP STARTTLS");
      session.upgradeToTls();
      // TLS 升级后 capability 可能变化，必须重新 EHLO，不能复用升级前的 AUTH 列表。
      response = await session.command("EHLO drop-worker");
      expect(response, [250], "SMTP TLS EHLO");
    }

    if (config.username || config.password) {
      // 只有同时配置用户名和密码才尝试认证；优先 PLAIN，其次 LOGIN，兼容常见 SMTP 服务商。
      if (!config.username || !config.password) throw new Error("SMTP 用户名和密码必须同时配置");
      const auth = response.lines.join(" ").toLocaleUpperCase();
      if (auth.includes("AUTH PLAIN") || auth.includes("AUTH=PLAIN")) {
        let authResponse = await session.command(`AUTH PLAIN ${base64(`\0${config.username}\0${config.password}`)}`);
        if (authResponse.code === 334) {
          authResponse = await session.command(base64(`\0${config.username}\0${config.password}`));
        }
        expect(authResponse, [235], "SMTP AUTH PLAIN");
      } else if (auth.includes("AUTH LOGIN") || auth.includes("AUTH=LOGIN")) {
        expect(await session.command("AUTH LOGIN"), [334], "SMTP AUTH LOGIN");
        expect(await session.command(base64(config.username)), [334], "SMTP 用户名认证");
        expect(await session.command(base64(config.password)), [235], "SMTP 密码认证");
      } else {
        throw new Error("SMTP 服务器未提供 AUTH PLAIN 或 AUTH LOGIN");
      }
    }

    expect(await session.command(`MAIL FROM:<${message.from}>`), [250], "SMTP MAIL FROM");
    expect(await session.command(`RCPT TO:<${message.to}>`), [250, 251], "SMTP RCPT TO");
    expect(await session.command("DATA"), [354], "SMTP DATA");
    expect(await session.writeData(message.raw), [250], "SMTP 邮件投递");
    // QUIT 失败不应掩盖已收到 250 的投递结果，因此只记录为可忽略的连接收尾错误。
    await session.command("QUIT").catch(() => undefined);
  } finally {
    // 无论握手、认证还是投递哪一步失败，都关闭 reader/writer 和 socket。
    await session.close();
  }
}
