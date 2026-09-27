// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Review Submission Flow
 *
 * Tests the complete review submission flow including:
 * - Selecting review types (Approve, Comment, Request Changes)
 * - Entering review summary/body
 * - Submitting reviews and verifying success toast
 * - Error handling for submission failures
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// Helper to open the review modal
async function openReviewModal(page) {
  await waitForDiffToRender(page);
  const reviewBtn = page.locator('.split-button-main').first();
  await reviewBtn.click();
  await page.waitForSelector('.review-modal-overlay', { timeout: 5000 });
}

test.describe('Review Type Selection', () => {
  test('should have Comment selected by default', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Check that COMMENT is selected by default
    const commentRadio = page.locator('input[value="COMMENT"]');
    await expect(commentRadio).toBeChecked();
  });

  test('should be able to select Approve review type', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE
    const approveRadio = page.locator('input[value="APPROVE"]');
    await approveRadio.click();
    await expect(approveRadio).toBeChecked();

    // Verify other options are not checked
    const commentRadio = page.locator('input[value="COMMENT"]');
    const requestChangesRadio = page.locator('input[value="REQUEST_CHANGES"]');
    await expect(commentRadio).not.toBeChecked();
    await expect(requestChangesRadio).not.toBeChecked();
  });

  test('should be able to select Request Changes review type', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select REQUEST_CHANGES
    const requestChangesRadio = page.locator('input[value="REQUEST_CHANGES"]');
    await requestChangesRadio.click();
    await expect(requestChangesRadio).toBeChecked();

    // Verify other options are not checked
    const commentRadio = page.locator('input[value="COMMENT"]');
    const approveRadio = page.locator('input[value="APPROVE"]');
    await expect(commentRadio).not.toBeChecked();
    await expect(approveRadio).not.toBeChecked();
  });

  test('should display all three main review type options', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // All three main review types should be visible
    await expect(page.locator('input[value="APPROVE"]')).toBeVisible();
    await expect(page.locator('input[value="COMMENT"]')).toBeVisible();
    await expect(page.locator('input[value="REQUEST_CHANGES"]')).toBeVisible();
  });

  test('should also have Draft option available', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Draft option should also be present
    await expect(page.locator('input[value="DRAFT"]')).toBeVisible();
  });
});

test.describe('Review Summary Input', () => {
  test('should have a textarea for review body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const textarea = page.locator('#review-body-modal');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAttribute('placeholder', /leave a comment/i);
  });

  test('should be able to enter review summary text', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    const textarea = page.locator('#review-body-modal');
    const testText = 'This is a test review summary for the PR.';
    await textarea.fill(testText);

    await expect(textarea).toHaveValue(testText);
  });

  test('should clear textarea when modal is reopened', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter some text
    const textarea = page.locator('#review-body-modal');
    await textarea.fill('Some test text');

    // Close modal
    await page.locator('#cancel-review-btn').click();
    await page.waitForSelector('.review-modal-overlay', { state: 'hidden', timeout: 5000 });

    // Reopen modal
    await openReviewModal(page);

    // Textarea should be empty
    await expect(textarea).toHaveValue('');
  });
});

test.describe('Review Submission Success', () => {
  test('keeps a visible list of comments retained in pair-review after submission', async ({ page }) => {
    await page.route('**/api/pr/test-owner/test-repo/1/submit-review', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true, comments_submitted: 1,
        github_url: 'https://github.com/test-owner/test-repo/pull/1#pullrequestreview-1',
        skipped_comments: [{
          id: 91, file: 'src/unchanged-helper.js', line_start: 10, line_end: 12,
          body: 'This caller still needs to handle the new result.', reason: 'outside_diff'
        }]
      })
    }));
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);
    await page.locator('#review-body-modal').fill('Reviewed the changed files.');
    await page.locator('#submit-review-btn-modal').click();

    await expect(page.locator('.review-modal-overlay')).toBeHidden();
    const notice = page.locator('#retained-review-comments');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('1 comment kept in pair-review');
    await expect(notice).toContainText('src/unchanged-helper.js:10–12');
    await expect(notice).toContainText('This caller still needs to handle the new result.');
    await expect(notice).toContainText('They remain active in pair-review.');

    // The result remains readable independently of the transient success toast.
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(toast => toast.remove()));
    await page.evaluate(() => window.prManager.loadUserComments());
    await expect(notice).toBeVisible();
    const heading = await notice.locator('h2').boundingBox();
    const toolbar = await page.locator('.diff-toolbar').boundingBox();
    expect(heading.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
    await notice.getByRole('button', { name: 'Dismiss retained comments notice' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('clearing comments also clears the retained-comments notice', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await page.route('**/api/reviews/*/comments', route => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"deletedCount":1}' });
      }
      return route.continue();
    });
    await page.evaluate(() => {
      const row = document.createElement('div');
      row.className = 'user-comment-row';
      document.getElementById('diff-container').appendChild(row);
      window.confirmDialog = { show: async () => 'confirm' };
      window.prManager.showRetainedCommentsNotice([{
        file: 'unchanged.js', body: 'Keep this local', line_start: 10
      }]);
    });
    await expect(page.locator('#retained-review-comments')).toBeVisible();
    await page.evaluate(() => window.prManager.clearAllUserComments());
    await expect(page.locator('#retained-review-comments')).toHaveCount(0);
  });

  test('shows retained comments when no GitHub review was submitted', async ({ page }) => {
    await page.route('**/api/pr/test-owner/test-repo/1/submit-review', route => route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'No review body or comments can be submitted to GitHub.',
        skippedComments: [{ file: 'unchanged.js', line_start: 10, body: 'Keep this local' }]
      })
    }));
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);
    await page.locator('#submit-review-btn-modal').click();
    await expect(page.locator('.review-modal-overlay')).toBeHidden();
    await expect(page.locator('#retained-review-comments')).toContainText('Keep this local');
  });

  test('should submit Comment review successfully', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review body
    const textarea = page.locator('#review-body-modal');
    await textarea.fill('Great changes, looks good!');

    // COMMENT is already selected by default, just submit
    const submitBtn = page.locator('#submit-review-btn-modal');
    await submitBtn.click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should submit Approve review successfully', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE
    await page.locator('input[value="APPROVE"]').click();

    // Enter review body
    await page.locator('#review-body-modal').fill('LGTM!');

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should submit Request Changes review with comment', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select REQUEST_CHANGES
    await page.locator('input[value="REQUEST_CHANGES"]').click();

    // Enter review body (required for request changes)
    await page.locator('#review-body-modal').fill('Please fix the formatting issues.');

    // Submit
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/review submitted/i);
  });

  test('should close modal after successful submission', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Enter review and submit
    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Modal should close
    const modal = page.locator('.review-modal-overlay');
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
  });

  test('should show View on GitHub link in success toast', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Submit a review
    await page.locator('#review-body-modal').fill('Test review');
    await page.locator('#submit-review-btn-modal').click();

    // Wait for success toast with link
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });

    // Should have a link to GitHub
    const link = toast.locator('.toast-link');
    await expect(link).toBeVisible();
    await expect(link).toContainText(/view on github/i);
  });
});

test.describe('Review Submission Validation', () => {
  test('should allow Comment submission without body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // COMMENT is default, submit without body
    await page.locator('#submit-review-btn-modal').click();

    // Should succeed (toast visible means no validation error blocked it)
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });

  test('should allow Approve submission without body', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await openReviewModal(page);

    // Select APPROVE and submit without body
    await page.locator('input[value="APPROVE"]').click();
    await page.locator('#submit-review-btn-modal').click();

    // Should succeed
    const toast = page.locator('.toast-success');
    await expect(toast).toBeVisible({ timeout: 10000 });
  });
});
