using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddJournalThumbnailByteLength : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ThumbnailByteLength",
                table: "JournalEntries",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.Sql("UPDATE JournalEntries SET ThumbnailByteLength = length(Thumbnail) WHERE Thumbnail IS NOT NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ThumbnailByteLength",
                table: "JournalEntries");
        }
    }
}
