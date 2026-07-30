using System.Buffers.Binary;

namespace Zhaojian.Api.Infrastructure;

internal static class JpegSanitizer
{
    internal static (byte[] Bytes, int Width, int Height) Sanitize(ReadOnlySpan<byte> jpeg)
    {
        var offset = 2;
        var width = 0;
        var height = 0;
        var hasQuantizationTable = false;
        var hasHuffmanTable = false;
        using var sanitized = new MemoryStream(jpeg.Length);
        sanitized.Write(jpeg[..2]);
        while (offset + 4 <= jpeg.Length)
        {
            var markerStart = offset;
            if (jpeg[offset] != 0xff) return ([], 0, 0);
            while (offset < jpeg.Length && jpeg[offset] == 0xff) offset++;
            if (offset >= jpeg.Length) return ([], 0, 0);
            var marker = jpeg[offset++];
            if (marker == 0xd9) return ([], 0, 0);
            if (marker is 0xd8 or 0x01 || marker is >= 0xd0 and <= 0xd7) continue;
            if (offset + 2 > jpeg.Length) return ([], 0, 0);
            var length = BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset, 2));
            if (length < 2 || offset + length > jpeg.Length) return ([], 0, 0);
            if (marker == 0xdb) hasQuantizationTable = true;
            if (marker == 0xc4) hasHuffmanTable = true;
            if (marker == 0xda)
            {
                if (width <= 0 || height <= 0 || !hasQuantizationTable || !hasHuffmanTable || offset + length >= jpeg.Length - 2)
                {
                    return ([], 0, 0);
                }
                sanitized.Write(jpeg[markerStart..]);
                return (sanitized.ToArray(), width, height);
            }
            if (marker is 0xc0 or 0xc1 or 0xc2 or 0xc3 or 0xc5 or 0xc6 or 0xc7 or 0xc9 or 0xca or 0xcb or 0xcd or 0xce or 0xcf)
            {
                if (length < 7) return ([], 0, 0);
                height = BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset + 3, 2));
                width = BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset + 5, 2));
            }
            var containsPrivateMetadata = marker is >= 0xe1 and <= 0xef || marker == 0xfe;
            if (!containsPrivateMetadata)
            {
                sanitized.Write(jpeg[markerStart..(offset + length)]);
            }
            offset += length;
        }
        return ([], 0, 0);
    }
}
