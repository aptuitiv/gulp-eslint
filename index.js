'use strict';

const PluginError = require('plugin-error');
const { ESLint } = require('eslint');
const {
	createIgnoreResult,
	filterResult,
	firstResultMessage,
	handleCallback,
	isErrorMessage,
	migrateOptions,
	resolveFormatter,
	resolveWritable,
	transform,
	tryResultAction,
	writeResults
} = require('./util');
const { relative } = require('path');

/**
 * Append ESLint result to each file
 *
 * @param {(Object|String)} [options] - Configure rules, env, global, and other options for running ESLint
 * @returns {stream} gulp file stream
 */
function gulpEslint(options) {
	options = migrateOptions(options) || {};
	const linter = new ESLint(options);

	return transform(async (file, enc, cb) => {
		const filePath = relative(process.cwd(), file.path);

		if (file.isNull()) {
			cb(null, file);
			return;
		}

		if (file.isStream()) {
			cb(new PluginError('gulp-eslint', 'gulp-eslint doesn\'t support vinyl files with Stream contents.'));
			return;
		}

		const isPathIgnored = await linter.isPathIgnored(filePath);
		if (isPathIgnored) {
			// Note:
			// Vinyl files can have an independently defined cwd, but ESLint works relative to `process.cwd()`.
			// (https://github.com/gulpjs/gulp/blob/master/docs/recipes/specifying-a-cwd.md)
			// Also, ESLint doesn't adjust file paths relative to an ancestory .eslintignore path.
			// E.g., If ../.eslintignore has "foo/*.js", ESLint will ignore ./foo/*.js, instead of ../foo/*.js.
			// Eslint rolls this into `CLIEngine.executeOnText`. So, gulp-eslint must account for this limitation.

			if (options.warnFileIgnored) {
				// Warn that gulp.src is needlessly reading files that ESLint ignores
				file.eslint = createIgnoreResult(file);
			}
			cb(null, file);
			return;
		}

		let result;

		try {
			result = await linter.lintText(file.contents.toString(), { filePath });
			result = result[0];
		} catch (e) {
			cb(new PluginError('gulp-eslint', e));
			return;
		}
		// Note: Fixes are applied as part of "executeOnText".
		// Any applied fix messages have been removed from the result.

		if (options.quiet) {
			// ignore warnings
			file.eslint = filterResult(result, options.quiet);
		} else {
			file.eslint = result;
		}

		// Update the fixed output; otherwise, fixable messages are simply ignored.
		if (file.eslint.hasOwnProperty('output')) {
			file.contents = Buffer.from(file.eslint.output);
			file.eslint.fixed = true;
		}
		cb(null, file);
	});
}

/**
 * Handle each ESLint result as it passes through the stream.
 *
 * @param {Function} action - A function to handle each ESLint result
 * @returns {stream} gulp file stream
 */
gulpEslint.result = action => {
	if (typeof action !== 'function') {
		throw new Error('Expected callable argument');
	}

	return transform((file, enc, done) => {
		if (file.eslint) {
			tryResultAction(action, file.eslint, handleCallback(done, file));
		} else {
			done(null, file);
		}
	});
};

/**
 * Handle all ESLint results at the end of the stream.
 *
 * @param {Function} action - A function to handle all ESLint results
 * @returns {stream} gulp file stream
 */
gulpEslint.results = function (action) {
	if (typeof action !== 'function') {
		throw new Error('Expected callable argument');
	}

	const results = [];
	results.errorCount = 0;
	results.warningCount = 0;

	return transform((file, enc, done) => {
		if (file.eslint) {
			results.push(file.eslint);
			// collect total error/warning count
			results.errorCount += file.eslint.errorCount;
			results.warningCount += file.eslint.warningCount;
		}
		done(null, file);

	}, done => {
		tryResultAction(action, results, handleCallback(done));
	});
};

/**
 * Fail when an ESLint error is found in ESLint results.
 *
 * @returns {stream} gulp file stream
 */
gulpEslint.failOnError = () => {
	return gulpEslint.result(result => {
		const error = firstResultMessage(result, isErrorMessage);
		if (!error) {
			return;
		}

		throw new PluginError('gulp-eslint', {
			name: 'ESLintError',
			fileName: result.filePath,
			message: error.message,
			lineNumber: error.line
		});
	});
};

/**
 * Fail when the stream ends if any ESLint error(s) occurred
 *
 * @returns {stream} gulp file stream
 */
gulpEslint.failAfterError = () => {
	return gulpEslint.results(results => {
		const count = results.errorCount;
		if (!count) {
			return;
		}

		throw new PluginError('gulp-eslint', {
			name: 'ESLintError',
			message: 'Failed with ' + count + (count === 1 ? ' error' : ' errors')
		});
	});
};

/**
 * Format the results of each file individually.
 *
 * @param {(String|Function)} [formatter=stylish] - The name or function for a ESLint result formatter
 * @param {(Function|Stream)} [writable=fancy-log] - A funtion or stream to write the formatted ESLint results.
 * @returns {stream} gulp file stream
 */
gulpEslint.formatEach = (formatter, writable) => {
	writable = resolveWritable(writable);

	return gulpEslint.result(result => {
		resolveFormatter(formatter).then(formatter => {
			writeResults([result], formatter, writable)
		});
	});
};

/**
 * Wait until all files have been linted and format all results at once.
 *
 * @param {(String|Function)} [formatter=stylish] - The name or function for a ESLint result formatter
 * @param {(Function|stream)} [writable=fancy-log] - A funtion or stream to write the formatted ESLint results.
 * @returns {stream} gulp file stream
 */
gulpEslint.format = (formatter, writable) => {
	writable = resolveWritable(writable);

	return gulpEslint.results(results => {
		if (results.length) {
			resolveFormatter(formatter).then(formatter => {
				writeResults(results, formatter.format, writable);
			});
		}
	});
};

module.exports = gulpEslint;
