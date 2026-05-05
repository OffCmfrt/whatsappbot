const cloudinary = require('cloudinary').v2;
const fs = require('fs');

console.log('Cloudinary Config:', {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecretPresent: !!process.env.CLOUDINARY_API_SECRET
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

class CloudinaryService {
  /**
   * Upload an image to Cloudinary
   * @param {string} filePath - Path to the local file
   * @param {string} folder - Optional folder name in Cloudinary
   * @returns {Promise<string>} - The secure URL of the uploaded image
   */
  async uploadImage(filePath, folder = 'whatsapp_bot') {
    try {
      const result = await cloudinary.uploader.upload(filePath, {
        folder: folder,
        resource_type: 'auto'
      });
      
      // Clean up the local file after upload
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      return result.secure_url;
    } catch (error) {
      console.error('Cloudinary Upload Error:', error);
      throw new Error('Failed to upload image to Cloudinary');
    }
  }

  /**
   * Upload buffer directly (alternative)
   * @param {Buffer} buffer - File buffer
   * @param {string} folder - Optional folder name
   * @returns {Promise<string>}
   */
  async uploadBuffer(buffer, folder = 'whatsapp_bot') {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: folder },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      uploadStream.end(buffer);
    });
  }
}

module.exports = new CloudinaryService();
