import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { dimensions, invalidateThumbnail } from './thumbnails.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { detectImageFormat, normalizeImageFileName } from '../media-validation.js';

export const router = express.Router();

/**
 * Reads only enough bytes to identify an uploaded image.
 * @param {string} filePath Image path
 * @returns {{extension: string, mimeType: string}|null}
 */
function detectImageFormatFromFile(filePath) {
    const header = Buffer.alloc(32);
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
        return detectImageFormat(header.subarray(0, bytesRead));
    } finally {
        fs.closeSync(descriptor);
    }
}

router.post('/all', function (request, response) {
    const images = getImages(request.user.directories.backgrounds);
    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
    response.json({ images, config });
});

router.post('/delete', getFileNameValidationFunction('bg'), function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.bg !== sanitize(request.body.bg)) {
        console.error('Malicious bg name prevented');
        return response.sendStatus(403);
    }

    const fileName = path.join(request.user.directories.backgrounds, sanitize(request.body.bg));

    if (!fs.existsSync(fileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }

    fs.unlinkSync(fileName);
    invalidateThumbnail(request.user.directories, 'bg', request.body.bg);
    return response.send('ok');
});

router.post('/rename', function (request, response) {
    if (!request.body || typeof request.body.old_bg !== 'string' || typeof request.body.new_bg !== 'string') {
        return response.status(400).json({ error: 'invalid_background_name', message: 'Both the old and new background names are required.' });
    }

    const oldBackground = sanitize(request.body.old_bg);
    if (!oldBackground || oldBackground !== request.body.old_bg) {
        return response.status(400).json({ error: 'invalid_background_name', message: 'The existing background name is invalid.' });
    }

    const oldFileName = path.join(request.user.directories.backgrounds, oldBackground);
    if (!fs.existsSync(oldFileName)) {
        console.error('BG file not found');
        return response.status(404).json({ error: 'background_not_found', message: 'The background no longer exists.' });
    }

    try {
        const format = detectImageFormatFromFile(oldFileName);
        if (!format) {
            return response.status(415).json({ error: 'invalid_background_file', message: 'The existing background is not a supported image.' });
        }

        const newBackground = normalizeImageFileName(request.body.new_bg, format.extension);
        const newFileName = path.join(request.user.directories.backgrounds, newBackground);
        if (fs.existsSync(newFileName)) {
            return response.status(409).json({ error: 'background_exists', message: 'A background with that name already exists.' });
        }

        fs.renameSync(oldFileName, newFileName);
        invalidateThumbnail(request.user.directories, 'bg', oldBackground);
        invalidateThumbnail(request.user.directories, 'bg', newBackground);
        return response.json({ old_bg: oldBackground, new_bg: newBackground });
    } catch (error) {
        console.error('Failed to rename background', error);
        return response.status(500).json({ error: 'background_rename_failed', message: 'The server could not rename the background.' });
    }
});

router.post('/upload', async function (request, response) {
    const uploadPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    try {
        if (!request.file || !uploadPath) {
            return response.status(400).json({ error: 'missing_background_file', message: 'No background file was uploaded.' });
        }

        const format = detectImageFormatFromFile(uploadPath);
        if (!format) {
            return response.status(415).json({
                error: 'invalid_background_file',
                message: 'Only PNG, JPEG, GIF, WebP, BMP, and AVIF images can be used as backgrounds. Videos must be converted to animated WebP first.',
            });
        }

        const filename = normalizeImageFileName(request.file.originalname, format.extension);
        fs.copyFileSync(uploadPath, path.join(request.user.directories.backgrounds, filename));
        invalidateThumbnail(request.user.directories, 'bg', filename);
        return response.send(filename);
    } catch (err) {
        console.error('Failed to upload background', err);
        return response.status(500).json({ error: 'background_upload_failed', message: 'The server could not save the background.' });
    } finally {
        if (uploadPath) {
            try {
                await fs.promises.rm(uploadPath, { force: true });
            } catch (error) {
                console.warn(`Failed to clean up uploaded background file: ${path.basename(uploadPath)}`, error);
            }
        }
    }
});
