import { describe, expect, it } from 'vitest';
import {
  validateCategoryAttributes,
  assertCategoryAttributesSatisfied,
} from '../../src/modules/catalog/domain/schema-validator.js';
import { ValidationError } from '../../src/errors.js';

describe('Category Attribute Schema Validator (Unit)', () => {
  it('passes validation when category has no required attributes', () => {
    const result = validateCategoryAttributes([], { anyAttr: 'value' });
    expect(result.valid).toBe(true);
    expect(result.missingAttributes).toEqual([]);
    expect(() => assertCategoryAttributesSatisfied([], { anyAttr: 'value' }, 'electronics')).not.toThrow();
  });

  it('passes validation when all required attributes are present and non-empty', () => {
    const required = ['brand', 'model', 'screen_size'];
    const attributes = {
      brand: 'Samsung',
      model: 'Galaxy S24',
      screen_size: '6.2 inches',
      extra_info: '5G support',
    };

    const result = validateCategoryAttributes(required, attributes);
    expect(result.valid).toBe(true);
    expect(result.missingAttributes).toEqual([]);
    expect(() => assertCategoryAttributesSatisfied(required, attributes, 'mobile-phones')).not.toThrow();
  });

  it('detects missing required attributes', () => {
    const required = ['brand', 'model', 'storage'];
    const attributes = {
      brand: 'Apple',
    };

    const result = validateCategoryAttributes(required, attributes);
    expect(result.valid).toBe(false);
    expect(result.missingAttributes).toEqual(['model', 'storage']);

    expect(() => assertCategoryAttributesSatisfied(required, attributes, 'smartphones')).toThrow(
      ValidationError,
    );
  });

  it('treats null, undefined, or empty/whitespace string as missing', () => {
    const required = ['brand', 'model', 'color'];
    const attributes = {
      brand: 'Apple',
      model: '   ',
      color: null,
    };

    const result = validateCategoryAttributes(required, attributes);
    expect(result.valid).toBe(false);
    expect(result.missingAttributes).toEqual(['model', 'color']);
  });

  it('treats 0, false, arrays, and non-empty objects as valid attribute values', () => {
    const required = ['warranty_months', 'water_resistant', 'supported_frequencies'];
    const attributes = {
      warranty_months: 0,
      water_resistant: false,
      supported_frequencies: ['5G', 'LTE'],
    };

    const result = validateCategoryAttributes(required, attributes);
    expect(result.valid).toBe(true);
    expect(result.missingAttributes).toEqual([]);
  });

  it('provides detailed Persian field error messages in ValidationError', () => {
    const required = ['brand', 'model'];
    const attributes = {};

    try {
      assertCategoryAttributesSatisfied(required, attributes, 'laptops');
      expect.fail('Should have thrown ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const valErr = err as ValidationError;
      expect(valErr.fieldErrors).toHaveLength(2);
      expect(valErr.fieldErrors?.[0]?.field).toBe('attributes.brand');
      expect(valErr.fieldErrors?.[1]?.field).toBe('attributes.model');
    }
  });
});
