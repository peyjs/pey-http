// Unit tests for lib/error.js — the boundary error factory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpError } from '../lib/error.js';

test('should_build_six_field_error_when_called_with_code_and_message', () => {
  const error = createHttpError('HTTP_REQUEST_FAILED', 'The transfer could not be completed');

  assert.equal(error.code, 'HTTP_REQUEST_FAILED');
  assert.equal(error.message, 'The transfer could not be completed');
  assert.equal(error.source, 'pey.http');
  assert.equal(error.type, 'operational');
  assert.ok(!Number.isNaN(Date.parse(error.timestamp)));
  assert.equal('detail' in error, false, 'detail stays absent when not needed');
});

test('should_accept_startup_type_and_optional_detail_when_given', () => {
  const error = createHttpError('HTTP_TRANSPORT_UNAVAILABLE', 'No fetch implementation is available', 'startup', {
    reason: 'no-fetch',
  });

  assert.equal(error.type, 'startup');
  assert.deepEqual(error.detail, { reason: 'no-fetch' });
});

test('should_reject_unsupported_codes_and_types_when_misused', () => {
  assert.throws(() => createHttpError('not-a-code', 'x'), TypeError);
  assert.throws(() => createHttpError('HTTP_REQUEST_FAILED', 'x', 'fatal'), TypeError);
});
