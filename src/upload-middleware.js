import multer from 'multer';

import { getConfigValue } from './util.js';

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getUploadLimits() {
    const defaultLimit = 500 * 1024 * 1024;
    return {
        fileSize: positiveInteger(getConfigValue('uploads.maxFileBytes', defaultLimit, 'number'), defaultLimit),
        fieldSize: positiveInteger(getConfigValue('uploads.maxFieldBytes', defaultLimit, 'number'), defaultLimit),
    };
}

/**
 * Creates the shared single-file upload middleware with stable error responses.
 * @param {string} destination Temporary upload directory
 * @param {{fileSize?: number, fieldSize?: number}} [overrides] Test or deployment overrides
 * @returns {import('express').RequestHandler}
 */
export function createUploadMiddleware(destination, overrides = {}) {
    const hasFileSizeOverride = Number.isSafeInteger(overrides.fileSize) && overrides.fileSize > 0;
    const hasFieldSizeOverride = Number.isSafeInteger(overrides.fieldSize) && overrides.fieldSize > 0;
    const defaults = hasFileSizeOverride && hasFieldSizeOverride ? {} : getUploadLimits();
    const limits = {
        fileSize: positiveInteger(overrides.fileSize, defaults.fileSize),
        fieldSize: positiveInteger(overrides.fieldSize, defaults.fieldSize),
    };
    const upload = multer({ dest: destination, limits }).single('avatar');

    return function uploadMiddleware(request, response, next) {
        upload(request, response, (error) => {
            if (!error) {
                next();
                return;
            }
            if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
                response.status(413).json({
                    error: 'upload_file_too_large',
                    message: 'The uploaded file exceeds the configured size limit.',
                });
                return;
            }
            if (error instanceof multer.MulterError && error.code === 'LIMIT_FIELD_VALUE') {
                response.status(413).json({
                    error: 'upload_field_too_large',
                    message: 'An upload field exceeds the configured size limit.',
                });
                return;
            }
            if (error instanceof multer.MulterError) {
                response.status(400).json({ error: 'invalid_upload', message: 'The multipart upload is invalid.' });
                return;
            }
            next(error);
        });
    };
}
