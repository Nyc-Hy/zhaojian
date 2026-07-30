using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddTaskSortKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnalysisTasks_UserId_ReferenceImageId_CreatedAt",
                table: "AnalysisTasks");

            migrationBuilder.AddColumn<long>(
                name: "CreatedAtUnixMs",
                table: "AnalysisTasks",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.CreateIndex(
                name: "IX_AnalysisTasks_UserId_ReferenceImageId_CreatedAtUnixMs",
                table: "AnalysisTasks",
                columns: new[] { "UserId", "ReferenceImageId", "CreatedAtUnixMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnalysisTasks_UserId_ReferenceImageId_CreatedAtUnixMs",
                table: "AnalysisTasks");

            migrationBuilder.DropColumn(
                name: "CreatedAtUnixMs",
                table: "AnalysisTasks");

            migrationBuilder.CreateIndex(
                name: "IX_AnalysisTasks_UserId_ReferenceImageId_CreatedAt",
                table: "AnalysisTasks",
                columns: new[] { "UserId", "ReferenceImageId", "CreatedAt" });
        }
    }
}
