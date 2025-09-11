const express = require('express');
const router = express.Router();

// Import Cloudinary and Multer
const cloudinary = require('../config/cloudinary');
const upload = require('../middleware/multer');

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

module.exports = router;