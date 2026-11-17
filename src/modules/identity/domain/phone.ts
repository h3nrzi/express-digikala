export interface PhoneNormalizationResult {
  isValid: boolean;
  normalized?: string; // E.164 format: +989XXXXXXXXX
  localFormat?: string; // 11-digit local format: 09XXXXXXXXX
  error?: string;
}

const PERSIAN_ARABIC_DIGIT_MAP: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

function convertDigitsToAscii(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (char) => PERSIAN_ARABIC_DIGIT_MAP[char] ?? char);
}

/**
 * Validates and normalizes Iranian mobile phone numbers.
 * Accepts:
 *  - 11-digit local format: `09xx...`
 *  - E.164 international format: `+989xx...` (or `00989xx...`)
 * Returns normalized E.164 (+989XXXXXXXXX) and local (09XXXXXXXXX) forms.
 */
export function normalizeIranianPhoneNumber(rawInput?: string | null): PhoneNormalizationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      error: 'شماره تلفن همراه الزامی است.',
    };
  }

  // Convert Persian/Arabic digits, remove spaces, dashes, parentheses
  let cleaned = convertDigitsToAscii(rawInput.trim()).replace(/[\s\-()]/g, '');

  // Handle leading international prefixes
  if (cleaned.startsWith('0098')) {
    cleaned = '+' + cleaned.substring(2);
  }

  // Pattern 1: E.164 (+989XXXXXXXXX) - exactly 13 characters
  const e164Regex = /^\+989\d{9}$/;
  // Pattern 2: Local 11-digit (09XXXXXXXXX) - exactly 11 digits
  const localRegex = /^09\d{9}$/;

  if (e164Regex.test(cleaned)) {
    const nineDigits = cleaned.substring(4);
    return {
      isValid: true,
      normalized: cleaned,
      localFormat: `09${nineDigits}`,
    };
  }

  if (localRegex.test(cleaned)) {
    const nineDigits = cleaned.substring(2);
    return {
      isValid: true,
      normalized: `+989${nineDigits}`,
      localFormat: cleaned,
    };
  }

  return {
    isValid: false,
    error:
      'فرمت شماره تلفن همراه نامعتبر است. شماره باید ۱۱ رقمی با فرمت ۰۹ یا فرمت بین‌المللی ۹۸۹+ باشد.',
  };
}

export function validateIranianPhoneNumber(rawInput?: string | null): boolean {
  return normalizeIranianPhoneNumber(rawInput).isValid;
}
