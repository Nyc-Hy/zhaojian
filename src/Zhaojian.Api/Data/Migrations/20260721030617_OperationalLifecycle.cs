using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Zhaojian.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class OperationalLifecycle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterColumn<byte[]>(
                name: "Content",
                table: "ReferenceImages",
                type: "BLOB",
                nullable: true,
                oldClrType: typeof(byte[]),
                oldType: "BLOB");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PurgedAt",
                table: "ReferenceImages",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ChargeDisposition",
                table: "AnalysisTasks",
                type: "TEXT",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PricingVersion",
                table: "AnalysisTasks",
                type: "TEXT",
                maxLength: 80,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PurgedAt",
                table: "ReferenceImages");

            migrationBuilder.DropColumn(
                name: "ChargeDisposition",
                table: "AnalysisTasks");

            migrationBuilder.DropColumn(
                name: "PricingVersion",
                table: "AnalysisTasks");

            migrationBuilder.AlterColumn<byte[]>(
                name: "Content",
                table: "ReferenceImages",
                type: "BLOB",
                nullable: false,
                defaultValue: new byte[0],
                oldClrType: typeof(byte[]),
                oldType: "BLOB",
                oldNullable: true);
        }
    }
}
