export interface SmsMessage {
  phone: string;
  code: string;
  sentAt: Date;
}

export interface SmsSenderPort {
  sendOtp(phone: string, code: string): Promise<void>;
}

export class InMemorySmsSender implements SmsSenderPort {
  private messages: SmsMessage[] = [];

  constructor(private readonly logCodes = false) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    this.messages.push({
      phone,
      code,
      sentAt: new Date(),
    });

    if (this.logCodes) {
      console.info(`[dev OTP] ${phone}: ${code}`);
    }
  }

  getSentMessages(): readonly SmsMessage[] {
    return [...this.messages];
  }

  getLastMessageFor(phone: string): SmsMessage | undefined {
    return [...this.messages].reverse().find((m) => m.phone === phone);
  }

  clear(): void {
    this.messages = [];
  }
}
