import { ValidationError } from '../../../errors.js';

export interface AttributeValidationResult {
  valid: boolean;
  missingAttributes: string[];
}

/**
 * Validates whether the family attributes fulfill the required attribute schema for a category.
 * An attribute is considered present if its value is not null, undefined, or an empty/whitespace string.
 * Numbers (including 0), booleans (including false), arrays, and objects are valid values.
 */
export function validateCategoryAttributes(
  requiredAttributes: readonly string[],
  attributes: Record<string, unknown> = {},
): AttributeValidationResult {
  const missingAttributes: string[] = [];

  for (const rawKey of requiredAttributes) {
    const key = rawKey.trim();
    if (!key) continue;

    const value = attributes[key];
    if (value === undefined || value === null) {
      missingAttributes.push(key);
      continue;
    }

    if (typeof value === 'string' && value.trim() === '') {
      missingAttributes.push(key);
      continue;
    }
  }

  return {
    valid: missingAttributes.length === 0,
    missingAttributes,
  };
}

/**
 * Asserts that the given attributes satisfy the category's required attribute schema.
 * Throws a ValidationError with structured fieldErrors if any required attribute is missing.
 */
export function assertCategoryAttributesSatisfied(
  requiredAttributes: readonly string[],
  attributes: Record<string, unknown> = {},
  categoryName: string = 'دسته‌بندی',
): void {
  const result = validateCategoryAttributes(requiredAttributes, attributes);
  if (!result.valid) {
    const fieldErrors = result.missingAttributes.map((attrKey) => ({
      field: `attributes.${attrKey}`,
      message: `مشخصه الزامی «${attrKey}» برای دسته‌بندی «${categoryName}» وارد نشده است.`,
    }));

    throw new ValidationError(
      `تأیید کالا امکان‌پذیر نیست: مشخصه‌های الزامی دسته‌بندی «${categoryName}» ناقص هستند.`,
      fieldErrors,
    );
  }
}
