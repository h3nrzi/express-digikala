import { describe, expect, it } from 'vitest';
import {
  normalizeIranianPhoneNumber,
  validateIranianPhoneNumber,
} from '../../src/modules/identity/domain/phone.js';

describe('Iranian Phone Number Validation & Normalization', () => {
  it('validates and normalizes valid 11-digit numbers starting with 09', () => {
    const result = normalizeIranianPhoneNumber('09123456789');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
    expect(result.localFormat).toBe('09123456789');
  });

  it('validates and normalizes valid E.164 numbers starting with +989', () => {
    const result = normalizeIranianPhoneNumber('+989123456789');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
    expect(result.localFormat).toBe('09123456789');
  });

  it('handles spaces and hyphens gracefully', () => {
    const result = normalizeIranianPhoneNumber(' 0912-345-6789 ');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
  });

  it('converts Persian digits to ASCII digits', () => {
    const result = normalizeIranianPhoneNumber('۰۹۱۲۳۴۵۶۷۸۹');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
  });

  it('rejects numbers not starting with 09 or +989', () => {
    const result1 = normalizeIranianPhoneNumber('02123456789');
    expect(result1.isValid).toBe(false);
    expect(result1.error).toBeDefined();

    const result2 = normalizeIranianPhoneNumber('+98212345678');
    expect(result2.isValid).toBe(false);
    expect(result2.error).toBeDefined();
  });

  it('rejects numbers that are too short or too long', () => {
    const tooShort = normalizeIranianPhoneNumber('091234567');
    expect(tooShort.isValid).toBe(false);

    const tooLong = normalizeIranianPhoneNumber('0912345678901');
    expect(tooLong.isValid).toBe(false);
  });

  it('rejects non-numeric characters', () => {
    const invalid = normalizeIranianPhoneNumber('0912abc6789');
    expect(invalid.isValid).toBe(false);
  });

  it('rejects empty or whitespace-only strings', () => {
    expect(normalizeIranianPhoneNumber('').isValid).toBe(false);
    expect(normalizeIranianPhoneNumber('   ').isValid).toBe(false);
  });

  it('validateIranianPhoneNumber helper returns boolean', () => {
    expect(validateIranianPhoneNumber('09123456789')).toBe(true);
    expect(validateIranianPhoneNumber('+989123456789')).toBe(true);
    expect(validateIranianPhoneNumber('invalid')).toBe(false);
  });
});
