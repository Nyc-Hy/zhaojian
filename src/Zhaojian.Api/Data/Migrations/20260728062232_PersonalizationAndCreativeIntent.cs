using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class PersonalizationAndCreativeIntent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CreativeIntentId",
                table: "JournalEntries",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GearSnapshotJson",
                table: "AnalysisTasks",
                type: "TEXT",
                maxLength: 8192,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "CreativeIntents",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    SourceAnalysisTaskId = table.Column<string>(type: "TEXT", maxLength: 48, nullable: true),
                    SelectedInterpretationId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", maxLength: 32768, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    CreatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CreativeIntents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CreativeIntents_AnalysisTasks_SourceAnalysisTaskId",
                        column: x => x.SourceAnalysisTaskId,
                        principalTable: "AnalysisTasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_CreativeIntents_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CreativePreferences",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    PreferenceKind = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    VisualStrategy = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    EvidenceCount = table.Column<int>(type: "INTEGER", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    CreatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    UpdatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CreativePreferences", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CreativePreferences_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "FeedbackRecords",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    ClientFeedbackId = table.Column<string>(type: "TEXT", maxLength: 96, nullable: false),
                    AnalysisTaskId = table.Column<string>(type: "TEXT", maxLength: 48, nullable: false),
                    DirectionId = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    VisualStrategy = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    FeedbackType = table.Column<string>(type: "TEXT", maxLength: 24, nullable: false),
                    Value = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    SkillSnapshotsJson = table.Column<string>(type: "TEXT", maxLength: 32768, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    CreatedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false),
                    SyncedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                    SyncedAtUnixMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeedbackRecords", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeedbackRecords_AnalysisTasks_AnalysisTaskId",
                        column: x => x.AnalysisTaskId,
                        principalTable: "AnalysisTasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_FeedbackRecords_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "PersonalizationSettings",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "TEXT", maxLength: 450, nullable: false),
                    MemoryEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    FeedbackSyncConsent = table.Column<bool>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PersonalizationSettings", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_PersonalizationSettings_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GlobalExperienceCandidates",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    SourceFeedbackId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    CandidateType = table.Column<string>(type: "TEXT", maxLength: 40, nullable: false),
                    PayloadJson = table.Column<string>(type: "TEXT", maxLength: 32768, nullable: false),
                    Status = table.Column<string>(type: "TEXT", maxLength: 24, nullable: false, defaultValue: "isolated"),
                    CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GlobalExperienceCandidates", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GlobalExperienceCandidates_FeedbackRecords_SourceFeedbackId",
                        column: x => x.SourceFeedbackId,
                        principalTable: "FeedbackRecords",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_JournalEntries_CreativeIntentId",
                table: "JournalEntries",
                column: "CreativeIntentId");

            migrationBuilder.CreateIndex(
                name: "IX_CreativeIntents_SourceAnalysisTaskId",
                table: "CreativeIntents",
                column: "SourceAnalysisTaskId");

            migrationBuilder.CreateIndex(
                name: "IX_CreativeIntents_UserId_SourceAnalysisTaskId_SelectedInterpretationId",
                table: "CreativeIntents",
                columns: new[] { "UserId", "SourceAnalysisTaskId", "SelectedInterpretationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CreativeIntents_UserId_UpdatedAtUnixMs",
                table: "CreativeIntents",
                columns: new[] { "UserId", "UpdatedAtUnixMs" });

            migrationBuilder.CreateIndex(
                name: "IX_CreativePreferences_UserId_UpdatedAtUnixMs",
                table: "CreativePreferences",
                columns: new[] { "UserId", "UpdatedAtUnixMs" });

            migrationBuilder.CreateIndex(
                name: "IX_CreativePreferences_UserId_VisualStrategy",
                table: "CreativePreferences",
                columns: new[] { "UserId", "VisualStrategy" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeedbackRecords_AnalysisTaskId",
                table: "FeedbackRecords",
                column: "AnalysisTaskId");

            migrationBuilder.CreateIndex(
                name: "IX_FeedbackRecords_UserId_ClientFeedbackId",
                table: "FeedbackRecords",
                columns: new[] { "UserId", "ClientFeedbackId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeedbackRecords_UserId_CreatedAtUnixMs",
                table: "FeedbackRecords",
                columns: new[] { "UserId", "CreatedAtUnixMs" });

            migrationBuilder.CreateIndex(
                name: "IX_GlobalExperienceCandidates_SourceFeedbackId",
                table: "GlobalExperienceCandidates",
                column: "SourceFeedbackId",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_JournalEntries_CreativeIntents_CreativeIntentId",
                table: "JournalEntries",
                column: "CreativeIntentId",
                principalTable: "CreativeIntents",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_JournalEntries_CreativeIntents_CreativeIntentId",
                table: "JournalEntries");

            migrationBuilder.DropTable(
                name: "CreativeIntents");

            migrationBuilder.DropTable(
                name: "CreativePreferences");

            migrationBuilder.DropTable(
                name: "GlobalExperienceCandidates");

            migrationBuilder.DropTable(
                name: "PersonalizationSettings");

            migrationBuilder.DropTable(
                name: "FeedbackRecords");

            migrationBuilder.DropIndex(
                name: "IX_JournalEntries_CreativeIntentId",
                table: "JournalEntries");

            migrationBuilder.DropColumn(
                name: "CreativeIntentId",
                table: "JournalEntries");

            migrationBuilder.DropColumn(
                name: "GearSnapshotJson",
                table: "AnalysisTasks");
        }
    }
}
