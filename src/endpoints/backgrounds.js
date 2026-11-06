import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { thumbnailDimensions, readMetadataIndex, renameMetadata, removeMetadata, getOrGenerateMetadataBatch } from './image-metadata.js';
import { getConfigValue, getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { ImageValidationError, normalizeImageFileName, validateImageBuffer } from '../media-validation.js';

export const router = express.Router();

/**
 * Reads and validates a complete image file.
 * @param {string} filePath Image path
 * @param {number} maxPixels Maximum decoded pixels
 * @returns {Promise<{format: {extension: string, mimeType: string}, width: number, height: number}>}
 */
async function validateImageFile(filePath, maxPixels) {
    return await validateImageBuffer(await fs.promises.readFile(filePath), { maxPixels });
}

function getBackgroundUploadLimits() {
    const maxFileBytes = getConfigValue('uploads.backgrounds.maxFileBytes', 64 * 1024 * 1024, 'number');
    const maxPixels = getConfigValue('uploads.backgrounds.maxPixels', 100_000_000, 'number');
    return {
        maxFileBytes: Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 64 * 1024 * 1024,
        maxPixels: Number.isSafeInteger(maxPixels) && maxPixels > 0 ? maxPixels : 100_000_000,
    };
}

router.post('/all', async function (request, response) {
    try {
        const images = getImages(request.user.directories.backgrounds);
        const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };

        // Get metadata for all images to provide isAnimated flag to client
        const relativePaths = images.map(img => path.join('backgrounds', img));
        const { results: metadataMap } = await getOrGenerateMetadataBatch(request.user.directories.root, relativePaths, 'bg');

        // Build response with metadata for each image
        const imagesWithMetadata = images.map(img => {
            const relativePath = path.join('backgrounds', img);
            const metadata = metadataMap[relativePath];
            return {
                filename: img,
                isAnimated: metadata?.isAnimated ?? false,
            };
        });

        response.json({ images: imagesWithMetadata, config });
    } catch (error) {
        console.error('[Backgrounds] Error fetching backgrounds:', error);
        response.status(500).json({ error: 'Failed to fetch backgrounds' });
    }
});

router.post('/folders', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        const folders = index.folders || [];

        // Build a slim map of image → folderIds for the frontend
        /** @type {Object.<string, string[]>} */
        const imageFolderMap = {};
        for (const [relativePath, meta] of Object.entries(index.images)) {
            if (Array.isArray(meta.folderIds) && meta.folderIds.length > 0) {
                // Strip the directory prefix to get just the filename
                const filename = relativePath.split('/').pop() || relativePath;
                imageFolderMap[filename] = meta.folderIds;
            }
        }

        response.json({ folders, imageFolderMap });
    } catch (error) {
        console.error('[Backgrounds] Folders endpoint error:', error);
        response.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    try {
        if (!request.body || typeof request.body.bg !== 'string') return response.sendStatus(400);

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

        // Remove metadata for deleted image
        const relativePath = path.join('backgrounds', request.body.bg);
        await removeMetadata(request.user.directories.root, relativePath).catch(err => {
            console.warn('[Backgrounds] Failed to remove metadata:', err.message);
        });
        return response.send('ok');
    } catch (error) {
        // An async route: an error must not escape, or it takes the whole server down.
        console.error('Failed to delete background', error);
        return response.sendStatus(500);
    }
});

router.post('/rename', async function (request, response) {
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
        const { maxPixels } = getBackgroundUploadLimits();
        const { format } = await validateImageFile(oldFileName, maxPixels);

        const newBackground = normalizeImageFileName(request.body.new_bg, format.extension);
        const newFileName = path.join(request.user.directories.backgrounds, newBackground);
        await fs.promises.copyFile(oldFileName, newFileName, fs.constants.COPYFILE_EXCL);
        try {
            await fs.promises.unlink(oldFileName);
        } catch (error) {
            await fs.promises.rm(newFileName, { force: true });
            throw error;
        }
        invalidateThumbnail(request.user.directories, 'bg', oldBackground);
        invalidateThumbnail(request.user.directories, 'bg', newBackground);

        // Update metadata for renamed image
        const oldRelativePath = path.join('backgrounds', oldBackground);
        const newRelativePath = path.join('backgrounds', newBackground);
        await renameMetadata(request.user.directories.root, oldRelativePath, newRelativePath).catch(err => {
            console.warn('[Backgrounds] Failed to rename metadata:', err.message);
        });
        return response.json({ old_bg: oldBackground, new_bg: newBackground });
    } catch (error) {
        if (error?.code === 'EEXIST') {
            return response.status(409).json({ error: 'background_exists', message: 'A background with that name already exists.' });
        }
        if (error instanceof ImageValidationError) {
            return response.status(error.status).json({ error: 'invalid_background_file', message: 'The existing background is not a valid supported image.' });
        }
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

        const { maxFileBytes, maxPixels } = getBackgroundUploadLimits();
        const stats = await fs.promises.stat(uploadPath);
        if (stats.size > maxFileBytes) {
            return response.status(413).json({
                error: 'background_file_too_large',
                message: 'The background file exceeds the configured upload limit.',
            });
        }
        const { format } = await validateImageFile(uploadPath, maxPixels);

        const filename = normalizeImageFileName(request.file.originalname, format.extension);
        await fs.promises.copyFile(
            uploadPath,
            path.join(request.user.directories.backgrounds, filename),
            fs.constants.COPYFILE_EXCL,
        );
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        await getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            console.warn('[Backgrounds] Failed to generate metadata for upload:', err.message);
        });
        return response.send(filename);
    } catch (err) {
        if (err?.code === 'EEXIST') {
            return response.status(409).json({ error: 'background_exists', message: 'A background with that name already exists.' });
        }
        if (err instanceof ImageValidationError) {
            return response.status(err.status).json({
                error: err.code === 'image_pixel_limit_exceeded' ? 'background_pixel_limit_exceeded' : 'invalid_background_file',
                message: err.code === 'image_pixel_limit_exceeded'
                    ? 'The background dimensions exceed the configured pixel limit.'
                    : 'Only complete PNG, JPEG, GIF, WebP, BMP, and AVIF images can be used as backgrounds.',
            });
        }
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
