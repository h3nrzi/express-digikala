export interface FieldErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fieldErrors?: FieldErrorDetail[] | undefined;
  public readonly retryAfterSeconds?: number | undefined;

  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    fieldErrors?: FieldErrorDetail[] | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: FieldErrorDetail[] | undefined) {
    super({
      message,
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      fieldErrors,
    });
    this.name = 'ValidationError';
  }
}

export class InvalidOtpError extends AppError {
  constructor(message: string = 'کد تأیید واردشده نادرست است.') {
    super({
      message,
      statusCode: 400,
      code: 'INVALID_OTP',
    });
    this.name = 'InvalidOtpError';
  }
}

export class OtpExpiredError extends AppError {
  constructor(message: string = 'کد تأیید منقضی شده است. لطفاً مجدداً درخواست ارسال کد دهید.') {
    super({
      message,
      statusCode: 400,
      code: 'OTP_EXPIRED',
    });
    this.name = 'OtpExpiredError';
  }
}

export class RateLimitError extends AppError {
  constructor(
    message: string = 'تعداد درخواست‌های ارسال کد بیش از حد مجاز است. لطفاً کمی صبر کرده و سپس تلاش کنید.',
    retryAfterSeconds: number = 60,
  ) {
    super({
      message,
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds,
    });
    this.name = 'RateLimitError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'دسترسی غیرمجاز. لطفاً ابتدا وارد حساب کاربری خود شوید.') {
    super({
      message,
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
    this.name = 'UnauthorizedError';
  }
}
