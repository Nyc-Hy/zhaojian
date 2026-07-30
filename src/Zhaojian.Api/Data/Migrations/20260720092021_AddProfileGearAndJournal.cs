using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileGearAndJournal : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GearKits",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 80, nullable: false),
                    Camera = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    CameraCatalogId = table.Column<string>(type: "TEXT", maxLength: 80, nullable: true),
                    CameraMount = table.Column<string>(type: "TEXT", maxLength: 80, nullable: true),
                    CameraSourceUrl = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    CameraSpecsVerifiedAt = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    SensorWidth = table.Column<double>(type: "REAL", nullable: false),
                    SensorHeight = table.Column<double>(type: "REAL", nullable: false),
                    CropFactor = table.Column<double>(type: "REAL", nullable: false),
                    LensName = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    FocalMin = table.Column<double>(type: "REAL", nullable: false),
                    FocalMax = table.Column<double>(type: "REAL", nullable: false),
                    Aperture = table.Column<double>(type: "REAL", nullable: false),
                    MinimumAperture = table.Column<double>(type: "REAL", nullable: true),
                    IbisStops = table.Column<double>(type: "REAL", nullable: false),
                    Tripod = table.Column<bool>(type: "INTEGER", nullable: false),
                    NdStopsJson = table.Column<string>(type: "TEXT", maxLength: 240, nullable: false),
                    MaxIso = table.Column<int>(type: "INTEGER", nullable: false),
                    MinIso = table.Column<int>(type: "INTEGER", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GearKits", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GearKits_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "JournalEntries",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    Intent = table.Column<string>(type: "TEXT", maxLength: 240, nullable: false),
                    GearName = table.Column<string>(type: "TEXT", maxLength: 80, nullable: false),
                    Direction = table.Column<string>(type: "TEXT", maxLength: 160, nullable: false),
                    Focal = table.Column<string>(type: "TEXT", maxLength: 80, nullable: false),
                    Method = table.Column<string>(type: "TEXT", maxLength: 800, nullable: false),
                    Reflection = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    Thumbnail = table.Column<byte[]>(type: "BLOB", nullable: true),
                    ThumbnailContentType = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    CreatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JournalEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JournalEntries_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GearKits_UserId_UpdatedAtUnixMs",
                table: "GearKits",
                columns: new[] { "UserId", "UpdatedAtUnixMs" });

            migrationBuilder.CreateIndex(
                name: "IX_JournalEntries_UserId_CreatedAtUnixMs",
                table: "JournalEntries",
                columns: new[] { "UserId", "CreatedAtUnixMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GearKits");

            migrationBuilder.DropTable(
                name: "JournalEntries");
        }
    }
}
