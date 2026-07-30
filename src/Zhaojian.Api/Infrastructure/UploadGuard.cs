using SkiaSharp;

namespace Zhaojian.Api.Infrastructure;

public static class UploadPolicy
{
    public const long MaxImageBytes = 2L * 1024 * 1024;
    public const long MaxRequestBytes = MaxImageBytes + 64 * 1024;
    public const int MaxRequestJsonChars = 8 * 1024;
    public const int MaxEdge = 2048;
    public const long MaxPixels = 4_194_304;
}

public sealed record ValidatedImage(byte[] Bytes, int Width, int Height, string MimeType);

public sealed class UploadGuard
{
    public async Task<ValidatedImage> ReadAndValidateAsync(IFormFile file, CancellationToken cancellationToken)
    {
        if (!string.Equals(file.ContentType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_IMAGE", "后端只接受前端重新编码后的 JPEG 分析图。");
        }
        if (file.Length is <= 0 or > UploadPolicy.MaxImageBytes)
        {
            throw new ApiException(StatusCodes.Status413PayloadTooLarge, "REQUEST_TOO_LARGE", "分析图必须小于或等于 2 MiB。");
        }

        await using var input = file.OpenReadStream();
        using var output = new MemoryStream((int)file.Length);
        await input.CopyToAsync(output, cancellationToken);
        var bytes = output.ToArray();
        if (bytes.Length != file.Length || bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[^2] != 0xff || bytes[^1] != 0xd9)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_IMAGE", "JPEG 文件不完整或文件头不正确。");
        }

        var (sanitizedBytes, width, height) = JpegSanitizer.Sanitize(bytes);
        if (width <= 0 || height <= 0 || width > UploadPolicy.MaxEdge || height > UploadPolicy.MaxEdge || (long)width * height > UploadPolicy.MaxPixels)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_IMAGE", "分析图最长边不能超过 2048px，且总像素不能超过 4194304。");
        }
        EnsureDecodable(sanitizedBytes, width, height);
        return new ValidatedImage(sanitizedBytes, width, height, "image/jpeg");
    }

    private static void EnsureDecodable(byte[] jpeg, int expectedWidth, int expectedHeight)
    {
        try
        {
            using var data = SKData.CreateCopy(jpeg);
            using var codec = SKCodec.Create(data);
            if (codec is null || codec.Info.Width != expectedWidth || codec.Info.Height != expectedHeight)
                throw InvalidImage();
            var info = new SKImageInfo(expectedWidth, expectedHeight, SKColorType.Rgba8888, SKAlphaType.Unpremul);
            using var bitmap = new SKBitmap(info);
            if (codec.GetPixels(info, bitmap.GetPixels()) != SKCodecResult.Success) throw InvalidImage();
        }
        catch (ApiException) { throw; }
        catch { throw InvalidImage(); }

        static ApiException InvalidImage() => new(StatusCodes.Status400BadRequest, "INVALID_IMAGE", "JPEG 像素数据无法完整解码。");
    }

}
