using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddCompletedAtUnixMs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnalysisTasks_ReferenceImageId",
                table: "AnalysisTasks");

            migrationBuilder.AddColumn<long>(
                name: "CompletedAtUnixMs",
                table: "AnalysisTasks",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.Sql("""
                UPDATE AnalysisTasks
                SET CompletedAtUnixMs = CAST(strftime('%s', CompletedAt) AS INTEGER) * 1000
                WHERE CompletedAt IS NOT NULL
                """);

            migrationBuilder.CreateIndex(
                name: "IX_AnalysisTasks_ReferenceImageId_CompletedAtUnixMs",
                table: "AnalysisTasks",
                columns: new[] { "ReferenceImageId", "CompletedAtUnixMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnalysisTasks_ReferenceImageId_CompletedAtUnixMs",
                table: "AnalysisTasks");

            migrationBuilder.DropColumn(
                name: "CompletedAtUnixMs",
                table: "AnalysisTasks");

            migrationBuilder.CreateIndex(
                name: "IX_AnalysisTasks_ReferenceImageId",
                table: "AnalysisTasks",
                column: "ReferenceImageId");
        }
    }
}
