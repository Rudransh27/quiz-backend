const express = require('express');
const router = express.Router();

// Import Cloudinary and Multer
const cloudinary = require('../config/cloudinary');
const upload = require('../middleware/multer');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

// ... (Your existing API routes and imports) ...

// New route for image upload
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    // CONSTRUCT THE DATA URI HERE
    // The format is: `data:<mime-type>;base64,<base64-string>`
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    // Upload the image using the data URI
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: "xbrl-app-images", // Optional: store images in a specific folder
    });

    // Return the secure URL of the uploaded image
    res.status(200).json({
      success: true,
      imageUrl: result.secure_url,
    });
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    res.status(500).json({ success: false, message: 'Image upload failed.' });
  }
});

// Generic video upload (no Card/Topic/Module coupling) — used by features
// like News/Broadcast that just need a hosted video URL, not a Card
// document. Streams the buffer to Cloudinary rather than a base64 data URI
// (same approach topicRoutes.js's Card video-upload routes use), since
// video files are far larger than the images /upload-image handles.
router.post('/upload-video', [auth, admin], upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file uploaded.' });
    }

    const uploadStream = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: 'xbrl-app-videos',
            chunk_size: 6000000,
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          },
        );
        stream.end(req.file.buffer);
      });

    const result = await uploadStream();

    res.status(200).json({
      success: true,
      videoUrl: result.secure_url,
    });
  } catch (error) {
    console.error("Cloudinary video upload error:", error);
    res.status(500).json({ success: false, message: 'Video upload failed.' });
  }
});

module.exports = router;