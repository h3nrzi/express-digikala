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

export class ForbiddenError extends AppError {
  constructor(
    message: string = 'دسترسی غیرمجاز. شما مجوز لازم برای انجام این عملیات را ندارید.',
    code: string = 'FORBIDDEN',
  ) {
    super({
      message,
      statusCode: 403,
      code,
    });
    this.name = 'ForbiddenError';
  }
}

export class MfaRequiredError extends AppError {
  constructor(
    message: string = 'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
  ) {
    super({
      message,
      statusCode: 403,
      code: 'MFA_REQUIRED',
    });
    this.name = 'MfaRequiredError';
  }
}

export class InviteExpiredError extends AppError {
  constructor(
    message: string = 'دعوت‌نامه منقضی شده است. لطفاً از مدیر سیستم درخواست دعوت جدید نمایید.',
  ) {
    super({
      message,
      statusCode: 400,
      code: 'INVITE_EXPIRED',
    });
    this.name = 'InviteExpiredError';
  }
}

export class InviteAlreadyUsedError extends AppError {
  constructor(message: string = 'این دعوت‌نامه قبلاً مورد استفاده قرار گرفته است.') {
    super({
      message,
      statusCode: 400,
      code: 'INVITE_ALREADY_USED',
    });
    this.name = 'InviteAlreadyUsedError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'منبع مورد نظر یافت نشد.', code: string = 'NOT_FOUND') {
    super({
      message,
      statusCode: 404,
      code,
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string = 'منبع با مشخصات ارائه‌شده از قبل در سیستم وجود دارد.',
    code: string = 'CONFLICT',
  ) {
    super({
      message,
      statusCode: 409,
      code,
    });
    this.name = 'ConflictError';
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(
    message: string = 'تغییر وضعیت درخواستی مجاز نمی‌باشد.',
    code: string = 'INVALID_STATE_TRANSITION',
  ) {
    super({
      message,
      statusCode: 400,
      code,
    });
    this.name = 'InvalidStateTransitionError';
  }
}
