using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Zhaojian.Api.Data;

public sealed class ZhaojianDbContext(DbContextOptions<ZhaojianDbContext> options) : IdentityDbContext<ApplicationUser>(options)
{
    public DbSet<ReferenceImageRecord> ReferenceImages => Set<ReferenceImageRecord>();
    public DbSet<AnalysisTaskRecord> AnalysisTasks => Set<AnalysisTaskRecord>();
    public DbSet<GearKitRecord> GearKits => Set<GearKitRecord>();
    public DbSet<JournalEntryRecord> JournalEntries => Set<JournalEntryRecord>();
    public DbSet<PersonalizationSettingsRecord> PersonalizationSettings => Set<PersonalizationSettingsRecord>();
    public DbSet<FeedbackRecord> FeedbackRecords => Set<FeedbackRecord>();
    public DbSet<CreativePreferenceRecord> CreativePreferences => Set<CreativePreferenceRecord>();
    public DbSet<GlobalExperienceCandidateRecord> GlobalExperienceCandidates => Set<GlobalExperienceCandidateRecord>();
    public DbSet<CreativeIntentRecord> CreativeIntents => Set<CreativeIntentRecord>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<ApplicationUser>(entity =>
        {
            entity.Property(value => value.DisplayName).HasMaxLength(40);
            entity.HasIndex(value => value.NormalizedEmail).IsUnique();
        });

        builder.Entity<ReferenceImageRecord>(entity =>
        {
            entity.ToTable("ReferenceImages");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(48);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.Sha256).HasMaxLength(64);
            entity.Property(value => value.ContentType).HasMaxLength(32);
            entity.HasIndex(value => new { value.UserId, value.Sha256 }).IsUnique();
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<AnalysisTaskRecord>(entity =>
        {
            entity.ToTable("AnalysisTasks");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(48);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.ReferenceImageId).HasMaxLength(48);
            entity.Property(value => value.IdempotencyKey).HasMaxLength(128);
            entity.Property(value => value.Fingerprint).HasMaxLength(64);
            entity.Property(value => value.Status).HasMaxLength(24);
            entity.Property(value => value.SkillSnapshotsJson).HasMaxLength(32768);
            entity.Property(value => value.GearSnapshotJson).HasMaxLength(8192);
            entity.Property(value => value.Provider).HasMaxLength(40);
            entity.Property(value => value.Model).HasMaxLength(100);
            entity.Property(value => value.ErrorCode).HasMaxLength(80);
            entity.Property(value => value.PricingVersion).HasMaxLength(80);
            entity.Property(value => value.ChargeDisposition).HasMaxLength(32);
            entity.Property(value => value.EstimatedCostCny).HasPrecision(18, 6);
            entity.HasIndex(value => new { value.UserId, value.IdempotencyKey }).IsUnique();
            entity.HasIndex(value => new { value.UserId, value.ReferenceImageId, value.CreatedAtUnixMs });
            entity.HasIndex(value => new { value.ReferenceImageId, value.CompletedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(value => value.ReferenceImage).WithMany(value => value.AnalysisTasks).HasForeignKey(value => value.ReferenceImageId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<GearKitRecord>(entity =>
        {
            entity.ToTable("GearKits");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.Name).HasMaxLength(80);
            entity.Property(value => value.Camera).HasMaxLength(120);
            entity.Property(value => value.CameraCatalogId).HasMaxLength(80);
            entity.Property(value => value.CameraMount).HasMaxLength(80);
            entity.Property(value => value.CameraSourceUrl).HasMaxLength(500);
            entity.Property(value => value.CameraSpecsVerifiedAt).HasMaxLength(32);
            entity.Property(value => value.LensName).HasMaxLength(120);
            entity.Property(value => value.NdStopsJson).HasMaxLength(240);
            entity.HasIndex(value => new { value.UserId, value.UpdatedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<JournalEntryRecord>(entity =>
        {
            entity.ToTable("JournalEntries");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.Intent).HasMaxLength(240);
            entity.Property(value => value.GearName).HasMaxLength(80);
            entity.Property(value => value.Direction).HasMaxLength(160);
            entity.Property(value => value.Focal).HasMaxLength(80);
            entity.Property(value => value.Method).HasMaxLength(800);
            entity.Property(value => value.Reflection).HasMaxLength(1000);
            entity.Property(value => value.ThumbnailContentType).HasMaxLength(32);
            entity.Property(value => value.CreativeIntentId).HasMaxLength(64);
            entity.HasIndex(value => new { value.UserId, value.CreatedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(value => value.CreativeIntent).WithMany(value => value.JournalEntries)
                .HasForeignKey(value => value.CreativeIntentId).OnDelete(DeleteBehavior.SetNull);
        });

        builder.Entity<PersonalizationSettingsRecord>(entity =>
        {
            entity.ToTable("PersonalizationSettings");
            entity.HasKey(value => value.UserId);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.HasOne(value => value.User).WithOne().HasForeignKey<PersonalizationSettingsRecord>(value => value.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<FeedbackRecord>(entity =>
        {
            entity.ToTable("FeedbackRecords");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.ClientFeedbackId).HasMaxLength(96);
            entity.Property(value => value.AnalysisTaskId).HasMaxLength(48);
            entity.Property(value => value.DirectionId).HasMaxLength(128);
            entity.Property(value => value.VisualStrategy).HasMaxLength(32);
            entity.Property(value => value.FeedbackType).HasMaxLength(24);
            entity.Property(value => value.Value).HasMaxLength(32);
            entity.Property(value => value.SkillSnapshotsJson).HasMaxLength(32768);
            entity.HasIndex(value => new { value.UserId, value.ClientFeedbackId }).IsUnique();
            entity.HasIndex(value => new { value.UserId, value.CreatedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(value => value.AnalysisTask).WithMany(value => value.FeedbackRecords)
                .HasForeignKey(value => value.AnalysisTaskId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CreativePreferenceRecord>(entity =>
        {
            entity.ToTable("CreativePreferences");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.PreferenceKind).HasMaxLength(32);
            entity.Property(value => value.VisualStrategy).HasMaxLength(32);
            entity.HasIndex(value => new { value.UserId, value.VisualStrategy }).IsUnique();
            entity.HasIndex(value => new { value.UserId, value.UpdatedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<GlobalExperienceCandidateRecord>(entity =>
        {
            entity.ToTable("GlobalExperienceCandidates");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.SourceFeedbackId).HasMaxLength(64);
            entity.Property(value => value.CandidateType).HasMaxLength(40);
            entity.Property(value => value.PayloadJson).HasMaxLength(32768);
            entity.Property(value => value.Status).HasMaxLength(24);
            entity.HasIndex(value => value.SourceFeedbackId).IsUnique();
            entity.Property(value => value.Status).HasDefaultValue("isolated");
            entity.HasOne(value => value.SourceFeedback).WithOne(value => value.GlobalCandidate)
                .HasForeignKey<GlobalExperienceCandidateRecord>(value => value.SourceFeedbackId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CreativeIntentRecord>(entity =>
        {
            entity.ToTable("CreativeIntents");
            entity.HasKey(value => value.Id);
            entity.Property(value => value.Id).HasMaxLength(64);
            entity.Property(value => value.UserId).HasMaxLength(450);
            entity.Property(value => value.SourceAnalysisTaskId).HasMaxLength(48);
            entity.Property(value => value.SelectedInterpretationId).HasMaxLength(128);
            entity.Property(value => value.PayloadJson).HasMaxLength(32768);
            entity.HasIndex(value => new { value.UserId, value.SourceAnalysisTaskId, value.SelectedInterpretationId }).IsUnique();
            entity.HasIndex(value => new { value.UserId, value.UpdatedAtUnixMs });
            entity.HasOne(value => value.User).WithMany().HasForeignKey(value => value.UserId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(value => value.SourceAnalysisTask).WithMany(value => value.CreativeIntents)
                .HasForeignKey(value => value.SourceAnalysisTaskId).OnDelete(DeleteBehavior.SetNull);
        });
    }
}
