using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Providers;
using Zhaojian.Api.Services;

namespace Zhaojian.Api.Tests;

public sealed class ApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databasePath = Path.Combine("/tmp", $"zhaojian-tests-{Guid.NewGuid():N}.db");
    private readonly string _skillStatePath = Path.Combine("/tmp", $"zhaojian-skill-state-{Guid.NewGuid():N}.json");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Zhaojian"] = $"Data Source={_databasePath};Cache=Shared",
            ["Model:Provider"] = "mock",
            ["SkillRegistry:StatePath"] = _skillStatePath,
            ["ApiProtection:AnalysesPerMinute"] = "100",
            ["ApiProtection:AccountRequestsPerFiveMinutes"] = "1000",
            ["ApiProtection:AnalysesPerDay"] = "100",
            ["ApiProtection:MaxConcurrentAnalyses"] = "4"
        }));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        foreach (var path in new[] { _databasePath, $"{_databasePath}-shm", $"{_databasePath}-wal", _skillStatePath })
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}

public sealed class ApiIntegrationTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Health_Model_Status_And_Anonymous_Session_Are_Available()
    {
        using var client = factory.CreateClient();
        Assert.Equal("Healthy", await client.GetStringAsync("/health"));
        using var status = JsonDocument.Parse(await client.GetStringAsync("/v1/models/status"));
        Assert.Equal("mock", status.RootElement.GetProperty("provider").GetString());
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        Assert.False(session.RootElement.GetProperty("authenticated").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(session.RootElement.GetProperty("csrfToken").GetString()));
    }

    [Fact]
    public async Task Register_Login_Logout_And_Protected_Boundary_Work()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "account");
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        Assert.True(session.RootElement.GetProperty("authenticated").GetBoolean());
        Assert.Contains("Member", session.RootElement.GetProperty("user").GetProperty("roles").EnumerateArray().Select(value => value.GetString()));

        using var logout = new HttpRequestMessage(HttpMethod.Post, "/v1/account/logout");
        logout.Headers.Add("X-CSRF-TOKEN", account.CsrfToken);
        using var logoutResponse = await client.SendAsync(logout);
        Assert.Equal(HttpStatusCode.NoContent, logoutResponse.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/v1/analysis-tasks")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/v1/reference-images/not-found")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/v1/skills/status")).StatusCode);

        var anonymousToken = await SessionTokenAsync(client);
        using var login = new HttpRequestMessage(HttpMethod.Post, "/v1/account/login");
        login.Headers.Add("X-CSRF-TOKEN", anonymousToken);
        login.Content = JsonContent.Create(new { email = account.Email, password = account.Password, rememberMe = false });
        using var loginResponse = await client.SendAsync(login);
        Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);
        using var restored = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        Assert.True(restored.RootElement.GetProperty("authenticated").GetBoolean());
        using var operations = JsonDocument.Parse(await client.GetStringAsync("/v1/operations/status"));
        Assert.Equal("1.0.0-beta.1", operations.RootElement.GetProperty("releaseVersion").GetString());
        Assert.False(operations.RootElement.GetProperty("multiInstanceReady").GetBoolean());
    }

    [Fact]
    public async Task Valid_Jpeg_Completes_Persists_And_Records_Usage()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "valid");
        using var response = await client.SendAsync(BuildRequest(CreateJpeg(800, 600), "image/jpeg", "idem_valid_001", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var accepted = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var analysisId = accepted.RootElement.GetProperty("analysis_id").GetString();
        using var body = await WaitForResultAsync(client, analysisId!);
        var result = body.RootElement.GetProperty("result");
        Assert.Equal("4.3", result.GetProperty("analysis").GetProperty("schema_version").GetString());
        Assert.InRange(result.GetProperty("analysis").GetProperty("interpretations").GetArrayLength(), 2, 5);
        Assert.Equal("mock", result.GetProperty("provider").GetProperty("mode").GetString());
        Assert.StartsWith("image_", accepted.RootElement.GetProperty("image_id").GetString());
        Assert.True(result.GetProperty("provider").GetProperty("timing").GetProperty("totalMs").GetInt64() >= 400);

        var directionId = result.GetProperty("analysis").GetProperty("interpretations")[0].GetProperty("id").GetString();
        using var planRequest = new HttpRequestMessage(HttpMethod.Post, "/v1/capture-plans");
        planRequest.Headers.Add("X-CSRF-TOKEN", account.CsrfToken);
        planRequest.Content = JsonContent.Create(new { taskId = analysisId, directionId, usingTripod = false, currentMetering = new { ev100 = 12.0, source = "camera_meter", measuredAt = DateTimeOffset.UtcNow } });
        using var planResponse = await client.SendAsync(planRequest);
        Assert.Equal(HttpStatusCode.OK, planResponse.StatusCode);
        using var plan = JsonDocument.Parse(await planResponse.Content.ReadAsStringAsync());
        Assert.Equal(account.GearId, plan.RootElement.GetProperty("gearKitId").GetString());
        Assert.True(plan.RootElement.GetProperty("safeShutterSeconds").GetDouble() > 0);

        using var detail = await client.GetAsync($"/v1/analysis-tasks/{analysisId}");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        using var detailBody = JsonDocument.Parse(await detail.Content.ReadAsStringAsync());
        var skillVersions = detailBody.RootElement.GetProperty("task").GetProperty("skillVersions");
        Assert.Equal(2, skillVersions.GetArrayLength());
        Assert.Contains(skillVersions.EnumerateArray(), value => value.GetProperty("skillId").GetString() == "observe-scene");

        using var skillStatus = JsonDocument.Parse(await client.GetStringAsync("/v1/skills/status"));
        Assert.True(skillStatus.RootElement.GetProperty("cloudSkillsEnabled").GetBoolean());
        Assert.Equal(2, skillStatus.RootElement.GetProperty("skills").GetArrayLength());
        Assert.All(skillStatus.RootElement.GetProperty("skills").EnumerateArray(), value =>
        {
            Assert.True(value.GetProperty("active").GetBoolean());
            Assert.StartsWith("sha256:", value.GetProperty("contentHash").GetString());
        });
        var usage = factory.Services.GetRequiredService<IUsageRecorder>().Snapshot();
        Assert.Contains(usage, record => record.RequestId == analysisId);
    }

    [Fact]
    public async Task Rejects_Invalid_Images_And_Request_Contracts()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "invalid");
        using var wrongType = await client.SendAsync(BuildRequest(CreateJpeg(10, 10), "image/png", "idem_wrong_type", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.BadRequest, wrongType.StatusCode);
        Assert.Equal("INVALID_IMAGE", await ProblemCode(wrongType));

        using var oversizedDimensions = await client.SendAsync(BuildRequest(CreateJpeg(2049, 100), "image/jpeg", "idem_big_edge", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.BadRequest, oversizedDimensions.StatusCode);

        using var undecodable = await client.SendAsync(BuildRequest(CreateCorruptJpeg(), "image/jpeg", "idem_bad_pixels", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.BadRequest, undecodable.StatusCode);
        Assert.Equal("INVALID_IMAGE", await ProblemCode(undecodable));

        var bytes = new byte[2 * 1024 * 1024 + 1];
        bytes[0] = 0xff; bytes[1] = 0xd8; bytes[^2] = 0xff; bytes[^1] = 0xd9;
        using var tooLarge = await client.SendAsync(BuildRequest(bytes, "image/jpeg", "idem_too_large", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);
        Assert.Equal("REQUEST_TOO_LARGE", await ProblemCode(tooLarge));

        using var unknown = await client.SendAsync(BuildRequest(CreateJpeg(10, 10), "image/jpeg", "idem_unknown", account.CsrfToken, account.GearId, "{\"intent\":\"亮光\",\"provider\":\"other\"}"));
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        using var missingKeyRequest = BuildRequest(CreateJpeg(10, 10), "image/jpeg", "idem_removed", account.CsrfToken, account.GearId);
        missingKeyRequest.Headers.Remove("Idempotency-Key");
        using var missingKey = await client.SendAsync(missingKeyRequest);
        Assert.Equal(HttpStatusCode.BadRequest, missingKey.StatusCode);
    }

    [Fact]
    public async Task Jpeg_Metadata_Is_Removed_Before_Persistence()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "metadata");
        var image = AddApp1Metadata(CreateJpeg(64, 48), "GPS-SECRET");
        using var accepted = await client.SendAsync(BuildRequest(image, "image/jpeg", "idem_metadata_001", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        using var body = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
        var imageId = body.RootElement.GetProperty("image_id").GetString();
        var stored = await client.GetByteArrayAsync($"/v1/reference-images/{imageId}");
        Assert.DoesNotContain("GPS-SECRET", Encoding.UTF8.GetString(stored));
        Assert.True(stored.Length < image.Length);
    }

    [Fact]
    public async Task Same_Idempotency_Key_Cannot_Represent_Different_Content()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "idempotency");
        using var first = await client.SendAsync(BuildRequest(CreateJpeg(20, 20), "image/jpeg", "idem_conflict_001", account.CsrfToken, account.GearId, "{\"intent\":\"亮光\"}"));
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        using var second = await client.SendAsync(BuildRequest(CreateJpeg(20, 20), "image/jpeg", "idem_conflict_001", account.CsrfToken, account.GearId, "{\"intent\":\"线条\"}"));
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("IDEMPOTENCY_CONFLICT", await ProblemCode(second));
    }

    [Fact]
    public async Task Concurrent_Retry_With_Same_Key_Executes_Only_Once()
    {
        using var isolatedFactory = factory.WithWebHostBuilder(_ => { });
        using var client = isolatedFactory.CreateClient();
        var account = await RegisterAsync(client, "parallel");
        var firstTask = client.SendAsync(BuildRequest(CreateJpeg(40, 30), "image/jpeg", "idem_parallel_001", account.CsrfToken, account.GearId));
        var secondTask = client.SendAsync(BuildRequest(CreateJpeg(40, 30), "image/jpeg", "idem_parallel_001", account.CsrfToken, account.GearId));
        var responses = await Task.WhenAll(firstTask, secondTask);
        using var first = responses[0];
        using var second = responses[1];
        Assert.All(responses, response => Assert.Equal(HttpStatusCode.Accepted, response.StatusCode));
        using var firstBody = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        using var secondBody = JsonDocument.Parse(await second.Content.ReadAsStringAsync());
        var analysisId = firstBody.RootElement.GetProperty("analysis_id").GetString();
        Assert.Equal(analysisId, secondBody.RootElement.GetProperty("analysis_id").GetString());
        using var completed = await WaitForResultAsync(client, analysisId!);
        Assert.Single(isolatedFactory.Services.GetRequiredService<IUsageRecorder>().Snapshot(), record => record.RequestId == analysisId);
    }

    [Fact]
    public async Task Rate_Limit_And_Daily_Quota_Are_Isolated_By_Account()
    {
        using var rateFactory = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ApiProtection:AnalysesPerMinute"] = "1",
            ["ApiProtection:AnalysesPerDay"] = "100"
        })));
        using var firstClient = rateFactory.CreateClient();
        using var secondClient = rateFactory.CreateClient();
        var firstAccount = await RegisterAsync(firstClient, "rate-a");
        var secondAccount = await RegisterAsync(secondClient, "rate-b");
        using var first = await firstClient.SendAsync(BuildRequest(CreateJpeg(30, 20), "image/jpeg", "idem_rate_001", firstAccount.CsrfToken, firstAccount.GearId));
        using var limited = await firstClient.SendAsync(BuildRequest(CreateJpeg(30, 20), "image/jpeg", "idem_rate_002", firstAccount.CsrfToken, firstAccount.GearId));
        using var other = await secondClient.SendAsync(BuildRequest(CreateJpeg(30, 20), "image/jpeg", "idem_rate_003", secondAccount.CsrfToken, secondAccount.GearId));
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        Assert.Equal("RATE_LIMITED", await ProblemCode(limited));
        Assert.Equal(HttpStatusCode.Accepted, other.StatusCode);

        using var quotaFactory = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ApiProtection:AnalysesPerMinute"] = "100",
            ["ApiProtection:AnalysesPerDay"] = "1"
        })));
        using var quotaClient = quotaFactory.CreateClient();
        var quotaAccount = await RegisterAsync(quotaClient, "quota");
        using var quotaFirst = await quotaClient.SendAsync(BuildRequest(CreateJpeg(31, 21), "image/jpeg", "idem_quota_001", quotaAccount.CsrfToken, quotaAccount.GearId));
        Assert.Equal(HttpStatusCode.Accepted, quotaFirst.StatusCode);
        using var firstAccepted = JsonDocument.Parse(await quotaFirst.Content.ReadAsStringAsync());
        using var firstComplete = await WaitForResultAsync(quotaClient, firstAccepted.RootElement.GetProperty("analysis_id").GetString()!);
        using var exhausted = await quotaClient.SendAsync(BuildRequest(CreateJpeg(31, 21), "image/jpeg", "idem_quota_002", quotaAccount.CsrfToken, quotaAccount.GearId));
        Assert.Equal(HttpStatusCode.Accepted, exhausted.StatusCode);
        using var exhaustedAccepted = JsonDocument.Parse(await exhausted.Content.ReadAsStringAsync());
        using var exhaustedDetail = await WaitForTerminalAsync(quotaClient, exhaustedAccepted.RootElement.GetProperty("analysis_id").GetString()!);
        Assert.Equal("failed", exhaustedDetail.RootElement.GetProperty("task").GetProperty("status").GetString());
        Assert.Equal("DAILY_QUOTA_EXCEEDED", exhaustedDetail.RootElement.GetProperty("errorCode").GetString());
    }

    [Fact]
    public async Task Same_Image_Has_Multiple_Results_And_Other_Account_Cannot_Read_Them()
    {
        using var owner = factory.CreateClient();
        using var stranger = factory.CreateClient();
        var ownerAccount = await RegisterAsync(owner, "owner");
        await RegisterAsync(stranger, "stranger");
        var image = CreateJpeg(64, 48);
        using var first = await owner.SendAsync(BuildRequest(image, "image/jpeg", "idem_history_001", ownerAccount.CsrfToken, ownerAccount.GearId, "{\"intent\":\"亮光\"}"));
        using var second = await owner.SendAsync(BuildRequest(image, "image/jpeg", "idem_history_002", ownerAccount.CsrfToken, ownerAccount.GearId, "{\"intent\":\"边缘线条\"}"));
        using var firstBody = JsonDocument.Parse(await first.Content.ReadAsStringAsync());
        using var secondBody = JsonDocument.Parse(await second.Content.ReadAsStringAsync());
        var firstId = firstBody.RootElement.GetProperty("analysis_id").GetString();
        var secondId = secondBody.RootElement.GetProperty("analysis_id").GetString();
        var imageId = firstBody.RootElement.GetProperty("image_id").GetString();
        Assert.Equal(imageId, secondBody.RootElement.GetProperty("image_id").GetString());
        using var firstCompleted = await WaitForResultAsync(owner, firstId!);
        using var secondCompleted = await WaitForResultAsync(owner, secondId!);

        using var usage = JsonDocument.Parse(await owner.GetStringAsync("/v1/account/usage"));
        Assert.True(usage.RootElement.GetProperty("tasksThisMonth").GetInt32() >= 2);
        Assert.True(usage.RootElement.GetProperty("completed").GetInt32() >= 2);

        using var list = JsonDocument.Parse(await owner.GetStringAsync($"/v1/analysis-tasks?imageId={imageId}"));
        Assert.Equal(2, list.RootElement.GetProperty("items").GetArrayLength());
        using var detail = await owner.GetAsync($"/v1/analysis-tasks/{firstId}");
        using var storedImage = await owner.GetAsync($"/v1/reference-images/{imageId}");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        using var detailBody = JsonDocument.Parse(await detail.Content.ReadAsStringAsync());
        Assert.True(detailBody.RootElement.GetProperty("result").GetProperty("analysis").GetProperty("observations").TryGetProperty("attention_candidates", out _));
        Assert.Equal("image/jpeg", storedImage.Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/v1/analysis-tasks/{firstId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/v1/reference-images/{imageId}")).StatusCode);

        var deleteToken = await SessionTokenAsync(owner);
        using var deleteFirst = new HttpRequestMessage(HttpMethod.Delete, $"/v1/analysis-tasks/{firstId}");
        deleteFirst.Headers.Add("X-CSRF-TOKEN", deleteToken);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(deleteFirst)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.GetAsync($"/v1/reference-images/{imageId}")).StatusCode);
        using var deleteSecond = new HttpRequestMessage(HttpMethod.Delete, $"/v1/analysis-tasks/{secondId}");
        deleteSecond.Headers.Add("X-CSRF-TOKEN", deleteToken);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(deleteSecond)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/v1/reference-images/{imageId}")).StatusCode);
    }

    [Fact]
    public async Task Profile_Gear_And_Journal_Are_Persisted_And_Isolated_By_Account()
    {
        using var profileFactory = factory.WithWebHostBuilder(_ => { });
        using var owner = profileFactory.CreateClient();
        using var stranger = profileFactory.CreateClient();
        var ownerAccount = await RegisterAsync(owner, "profile-owner");
        var strangerAccount = await RegisterAsync(stranger, "profile-stranger");

        using var updateProfile = new HttpRequestMessage(HttpMethod.Put, "/v1/account/profile");
        updateProfile.Headers.Add("X-CSRF-TOKEN", ownerAccount.CsrfToken);
        updateProfile.Content = JsonContent.Create(new { displayName = "山野观察者" });
        using var profileResponse = await owner.SendAsync(updateProfile);
        Assert.Equal(HttpStatusCode.OK, profileResponse.StatusCode);
        using var profileBody = JsonDocument.Parse(await profileResponse.Content.ReadAsStringAsync());
        Assert.Equal("山野观察者", profileBody.RootElement.GetProperty("displayName").GetString());
        Assert.True(profileBody.RootElement.TryGetProperty("createdAt", out _));

        var gearId = $"kit_{Guid.NewGuid():N}";
        using var saveGear = new HttpRequestMessage(HttpMethod.Post, "/v1/gear-kits");
        saveGear.Headers.Add("X-CSRF-TOKEN", ownerAccount.CsrfToken);
        saveGear.Content = JsonContent.Create(new
        {
            id = gearId, name = "山行摄影包", camera = "Fujifilm X-T5", cameraCatalogId = "fujifilm-x-t5",
            sensorWidth = 23.5, sensorHeight = 15.7, cropFactor = 1.5, lensName = "16–80mm F4", focalMin = 16,
            focalMax = 80, aperture = 4, minimumAperture = 22, ibisStops = 7, tripod = true, ndStops = new[] { 3.0, 6.0 }, maxIso = 3200, minIso = 125
        });
        Assert.Equal(HttpStatusCode.OK, (await owner.SendAsync(saveGear)).StatusCode);

        var journalId = Guid.NewGuid().ToString();
        var journalThumbnail = AddApp1Metadata(CreateJpeg(8, 8), "Exif\0\0GPS-JOURNAL-SECRET");
        using var saveJournal = new HttpRequestMessage(HttpMethod.Post, "/v1/journal-entries");
        saveJournal.Headers.Add("X-CSRF-TOKEN", ownerAccount.CsrfToken);
        saveJournal.Content = JsonContent.Create(new
        {
            id = journalId, createdAt = DateTimeOffset.UtcNow, intent = "雾中的层次", gearName = "山行摄影包", direction = "让山脊逐层退远",
            focal = "35–50mm", method = "先观察雾的变化再试拍", reflection = "保留自己的判断", thumbnailDataUrl = $"data:image/jpeg;base64,{Convert.ToBase64String(journalThumbnail)}"
        });
        Assert.Equal(HttpStatusCode.OK, (await owner.SendAsync(saveJournal)).StatusCode);

        using var invalidJournal = new HttpRequestMessage(HttpMethod.Post, "/v1/journal-entries");
        invalidJournal.Headers.Add("X-CSRF-TOKEN", ownerAccount.CsrfToken);
        invalidJournal.Content = JsonContent.Create(new
        {
            id = Guid.NewGuid().ToString(), createdAt = DateTimeOffset.UtcNow, intent = "测试", gearName = "山行摄影包", direction = "检查缩略图",
            focal = "35mm", method = "测试", reflection = "", thumbnailDataUrl = "data:image/jpeg;base64,/9j/2Q=="
        });
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.SendAsync(invalidJournal)).StatusCode);

        using var ownerGears = JsonDocument.Parse(await owner.GetStringAsync("/v1/gear-kits"));
        using var ownerJournals = JsonDocument.Parse(await owner.GetStringAsync("/v1/journal-entries"));
        using var strangerGears = JsonDocument.Parse(await stranger.GetStringAsync("/v1/gear-kits"));
        using var strangerJournals = JsonDocument.Parse(await stranger.GetStringAsync("/v1/journal-entries"));
        Assert.Equal(2, ownerGears.RootElement.GetProperty("items").GetArrayLength());
        Assert.Single(ownerJournals.RootElement.GetProperty("items").EnumerateArray());
        Assert.Single(strangerGears.RootElement.GetProperty("items").EnumerateArray());
        Assert.Empty(strangerJournals.RootElement.GetProperty("items").EnumerateArray());
        using var thumbnailResponse = await owner.GetAsync($"/v1/journal-entries/{journalId}/thumbnail");
        Assert.Equal("image/jpeg", thumbnailResponse.Content.Headers.ContentType?.MediaType);
        var storedThumbnail = await thumbnailResponse.Content.ReadAsByteArrayAsync();
        Assert.DoesNotContain("GPS-JOURNAL-SECRET", Encoding.UTF8.GetString(storedThumbnail));
        Assert.True(storedThumbnail.Length < journalThumbnail.Length);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/v1/journal-entries/{journalId}/thumbnail")).StatusCode);

        using var strangerDelete = new HttpRequestMessage(HttpMethod.Delete, $"/v1/gear-kits/{gearId}");
        strangerDelete.Headers.Add("X-CSRF-TOKEN", strangerAccount.CsrfToken);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.SendAsync(strangerDelete)).StatusCode);
    }

    [Fact]
    public async Task Account_Can_Change_Password_Export_Data_And_Delete_Itself()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "lifecycle");
        var token = await SessionTokenAsync(client);

        using var change = new HttpRequestMessage(HttpMethod.Post, "/v1/account/change-password");
        change.Headers.Add("X-CSRF-TOKEN", token);
        change.Content = JsonContent.Create(new { currentPassword = account.Password, newPassword = "newcamera12345" });
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(change)).StatusCode);

        var export = await client.GetAsync("/v1/account/export");
        Assert.Equal(HttpStatusCode.OK, export.StatusCode);
        await using (var stream = await export.Content.ReadAsStreamAsync())
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            var manifest = archive.GetEntry("manifest.json");
            Assert.NotNull(manifest);
            using var reader = new StreamReader(manifest!.Open());
            var json = await reader.ReadToEndAsync();
            Assert.Contains(account.Email, json);
            Assert.Contains(account.GearId, json);
        }

        token = await SessionTokenAsync(client);
        using var wrongDelete = new HttpRequestMessage(HttpMethod.Post, "/v1/account/delete");
        wrongDelete.Headers.Add("X-CSRF-TOKEN", token);
        wrongDelete.Content = JsonContent.Create(new { password = "wrong-password" });
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(wrongDelete)).StatusCode);

        using var delete = new HttpRequestMessage(HttpMethod.Post, "/v1/account/delete");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        delete.Content = JsonContent.Create(new { password = "newcamera12345" });
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        Assert.False(session.RootElement.GetProperty("authenticated").GetBoolean());
    }

    [Fact]
    public async Task Personalization_Requires_Consent_Two_Independent_Signals_And_Account_Ownership()
    {
        using var owner = factory.CreateClient();
        using var stranger = factory.CreateClient();
        var ownerAccount = await RegisterAsync(owner, "memory-owner");
        var strangerAccount = await RegisterAsync(stranger, "memory-stranger");
        var ownerToken = await SessionTokenAsync(owner);

        using (var settings = new HttpRequestMessage(HttpMethod.Put, "/v1/personalization/settings"))
        {
            settings.Headers.Add("X-CSRF-TOKEN", ownerToken);
            settings.Content = JsonContent.Create(new { memoryEnabled = true, feedbackSyncConsent = true });
            Assert.Equal(HttpStatusCode.OK, (await owner.SendAsync(settings)).StatusCode);
        }

        var firstTaskId = await SubmitAndWaitAsync(owner, ownerAccount, "idem_memory_001");
        var secondTaskId = await SubmitAndWaitAsync(owner, ownerAccount, "idem_memory_002");
        var firstDirection = await FirstDirectionAsync(owner, firstTaskId);
        var secondDirection = await FirstDirectionAsync(owner, secondTaskId);

        await SyncDirectionFeedbackAsync(owner, ownerToken, "client_memory_001", firstTaskId, firstDirection, "worth_trying");
        using (var afterOne = JsonDocument.Parse(await owner.GetStringAsync("/v1/personalization")))
        {
            Assert.Empty(afterOne.RootElement.GetProperty("preferences").EnumerateArray());
            Assert.Equal(1, afterOne.RootElement.GetProperty("isolatedGlobalCandidateCount").GetInt32());
        }

        await SyncDirectionFeedbackAsync(owner, ownerToken, "client_memory_002", secondTaskId, secondDirection, "worth_trying");
        string firstFeedbackId;
        using (var afterTwo = JsonDocument.Parse(await owner.GetStringAsync("/v1/personalization")))
        {
            var preference = Assert.Single(afterTwo.RootElement.GetProperty("preferences").EnumerateArray());
            Assert.Equal("explore_more", preference.GetProperty("preferenceKind").GetString());
            Assert.Equal(2, preference.GetProperty("evidenceCount").GetInt32());
            Assert.Equal(2, afterTwo.RootElement.GetProperty("isolatedGlobalCandidateCount").GetInt32());
            firstFeedbackId = afterTwo.RootElement.GetProperty("recentFeedback")[0].GetProperty("id").GetString()!;
        }
        using (var runtimeSkills = JsonDocument.Parse(await owner.GetStringAsync("/v1/skills/status")))
        {
            Assert.Equal(2, runtimeSkills.RootElement.GetProperty("skills").GetArrayLength());
        }
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/v1/global-experience-candidates")).StatusCode);
        using (var export = await owner.GetAsync("/v1/account/export"))
        await using (var stream = await export.Content.ReadAsStreamAsync())
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        using (var reader = new StreamReader(archive.GetEntry("manifest.json")!.Open()))
        using (var manifest = JsonDocument.Parse(await reader.ReadToEndAsync()))
        {
            var exportedPersonalization = manifest.RootElement.GetProperty("personalization");
            Assert.Equal(2, exportedPersonalization.GetProperty("feedback").GetArrayLength());
            Assert.Single(exportedPersonalization.GetProperty("preferences").EnumerateArray());
            Assert.Equal(2, exportedPersonalization.GetProperty("isolatedGlobalCandidates").GetArrayLength());
        }

        using (var strangerSettings = new HttpRequestMessage(HttpMethod.Put, "/v1/personalization/settings"))
        {
            strangerSettings.Headers.Add("X-CSRF-TOKEN", strangerAccount.CsrfToken);
            strangerSettings.Content = JsonContent.Create(new { memoryEnabled = true, feedbackSyncConsent = true });
            Assert.Equal(HttpStatusCode.OK, (await stranger.SendAsync(strangerSettings)).StatusCode);
        }
        using (var crossAccount = await BuildFeedbackSyncRequestAsync(
            strangerAccount.CsrfToken,
            "client_cross_account",
            firstTaskId,
            firstDirection,
            "worth_trying"))
        using (var crossResponse = await stranger.SendAsync(crossAccount))
        {
            Assert.Equal(HttpStatusCode.NotFound, crossResponse.StatusCode);
        }
        using (var strangerSnapshot = JsonDocument.Parse(await stranger.GetStringAsync("/v1/personalization")))
        {
            Assert.Empty(strangerSnapshot.RootElement.GetProperty("recentFeedback").EnumerateArray());
        }

        using (var revoke = new HttpRequestMessage(HttpMethod.Put, "/v1/personalization/settings"))
        {
            revoke.Headers.Add("X-CSRF-TOKEN", ownerToken);
            revoke.Content = JsonContent.Create(new { memoryEnabled = true, feedbackSyncConsent = false });
            Assert.Equal(HttpStatusCode.OK, (await owner.SendAsync(revoke)).StatusCode);
        }
        using (var blocked = await BuildFeedbackSyncRequestAsync(
            ownerToken,
            "client_memory_blocked",
            firstTaskId,
            firstDirection,
            "too_generic"))
        using (var blockedResponse = await owner.SendAsync(blocked))
        {
            Assert.Equal(HttpStatusCode.Conflict, blockedResponse.StatusCode);
            Assert.Equal("FEEDBACK_SYNC_NOT_CONSENTED", await ProblemCode(blockedResponse));
        }

        using (var deleteFeedback = new HttpRequestMessage(HttpMethod.Delete, $"/v1/personalization/feedback/{firstFeedbackId}"))
        {
            deleteFeedback.Headers.Add("X-CSRF-TOKEN", ownerToken);
            Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(deleteFeedback)).StatusCode);
        }
        using (var afterDelete = JsonDocument.Parse(await owner.GetStringAsync("/v1/personalization")))
        {
            Assert.Empty(afterDelete.RootElement.GetProperty("preferences").EnumerateArray());
            Assert.Equal(1, afterDelete.RootElement.GetProperty("isolatedGlobalCandidateCount").GetInt32());
        }

        using var clear = new HttpRequestMessage(HttpMethod.Delete, "/v1/personalization");
        clear.Headers.Add("X-CSRF-TOKEN", ownerToken);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(clear)).StatusCode);
        using var cleared = JsonDocument.Parse(await owner.GetStringAsync("/v1/personalization"));
        Assert.False(cleared.RootElement.GetProperty("settings").GetProperty("memoryEnabled").GetBoolean());
        Assert.Empty(cleared.RootElement.GetProperty("recentFeedback").EnumerateArray());
        Assert.Equal(0, cleared.RootElement.GetProperty("isolatedGlobalCandidateCount").GetInt32());
    }

    [Fact]
    public async Task Concurrent_Feedback_Sync_Is_Idempotent_And_Cannot_Exceed_Account_Quota()
    {
        using var client = factory.CreateClient();
        var account = await RegisterAsync(client, "memory-concurrency");
        var token = await SessionTokenAsync(client);
        using (var settings = new HttpRequestMessage(HttpMethod.Put, "/v1/personalization/settings"))
        {
            settings.Headers.Add("X-CSRF-TOKEN", token);
            settings.Content = JsonContent.Create(new { memoryEnabled = false, feedbackSyncConsent = true });
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(settings)).StatusCode);
        }
        var taskId = await SubmitAndWaitAsync(client, account, "idem_memory_concurrency");

        var duplicateRequests = Enumerable.Range(0, 8)
            .Select(_ => BuildAnalysisFeedbackSyncRequest(token, "client_memory_same", taskId))
            .ToArray();
        var duplicateResponses = await Task.WhenAll(duplicateRequests.Select(client.SendAsync));
        try
        {
            Assert.All(duplicateResponses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));
        }
        finally
        {
            foreach (var response in duplicateResponses) response.Dispose();
            foreach (var request in duplicateRequests) request.Dispose();
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
            var userId = await database.Users.Where(value => value.Email == account.Email).Select(value => value.Id).SingleAsync();
            Assert.Equal(1, await database.FeedbackRecords.CountAsync(value => value.UserId == userId));
            var now = DateTimeOffset.UtcNow;
            var remaining = Enumerable.Range(1, 4998).Select(index => new FeedbackRecord
            {
                Id = $"feedback_quota_{Guid.NewGuid():N}",
                UserId = userId,
                ClientFeedbackId = $"client_quota_seed_{index}",
                AnalysisTaskId = taskId,
                FeedbackType = "analysis",
                Value = "helpful",
                SkillSnapshotsJson = "[]",
                CreatedAt = now,
                CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
                SyncedAt = now,
                SyncedAtUnixMs = now.ToUnixTimeMilliseconds()
            });
            database.FeedbackRecords.AddRange(remaining);
            await database.SaveChangesAsync();
            Assert.Equal(4999, await database.FeedbackRecords.CountAsync(value => value.UserId == userId));
        }

        using var quotaRequestA = BuildAnalysisFeedbackSyncRequest(token, "client_quota_parallel_a", taskId);
        using var quotaRequestB = BuildAnalysisFeedbackSyncRequest(token, "client_quota_parallel_b", taskId);
        var quotaResponses = await Task.WhenAll(client.SendAsync(quotaRequestA), client.SendAsync(quotaRequestB));
        try
        {
            Assert.Single(quotaResponses, response => response.StatusCode == HttpStatusCode.OK);
            var rejected = Assert.Single(quotaResponses, response => response.StatusCode == HttpStatusCode.RequestEntityTooLarge);
            Assert.Equal("FEEDBACK_QUOTA_EXCEEDED", await ProblemCode(rejected));
        }
        finally
        {
            foreach (var response in quotaResponses) response.Dispose();
        }

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var verificationDatabase = verificationScope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
        var verificationUserId = await verificationDatabase.Users.Where(value => value.Email == account.Email).Select(value => value.Id).SingleAsync();
        Assert.Equal(5000, await verificationDatabase.FeedbackRecords.CountAsync(value => value.UserId == verificationUserId));
    }

    [Fact]
    public async Task CreativeIntent_Preserves_Provenance_Binds_Journal_And_Survives_Source_Deletion()
    {
        using var owner = factory.CreateClient();
        using var stranger = factory.CreateClient();
        var account = await RegisterAsync(owner, "intent-owner");
        await RegisterAsync(stranger, "intent-stranger");
        var taskId = await SubmitAndWaitAsync(owner, account, "idem_intent_001");
        var directionId = await FirstDirectionAsync(owner, taskId);
        var token = await SessionTokenAsync(owner);

        using var create = new HttpRequestMessage(HttpMethod.Post, $"/v1/analysis-tasks/{taskId}/creative-intents");
        create.Headers.Add("X-CSRF-TOKEN", token);
        create.Content = JsonContent.Create(new { selectedInterpretationId = directionId });
        using var created = await owner.SendAsync(create);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        using var createdBody = JsonDocument.Parse(await created.Content.ReadAsStringAsync());
        var intentId = createdBody.RootElement.GetProperty("creative_intent_id").GetString()!;
        Assert.Equal(taskId, createdBody.RootElement.GetProperty("source_analysis_id").GetString());
        Assert.Equal(account.GearId, createdBody.RootElement.GetProperty("gear_snapshot").GetProperty("id").GetString());
        Assert.Equal(2, createdBody.RootElement.GetProperty("skill_versions").GetArrayLength());
        Assert.NotEmpty(createdBody.RootElement.GetProperty("tradeoffs").EnumerateArray());

        using (var taskDetail = JsonDocument.Parse(await owner.GetStringAsync($"/v1/analysis-tasks/{taskId}")))
        {
            Assert.Equal(intentId, Assert.Single(taskDetail.RootElement.GetProperty("creativeIntents").EnumerateArray()).GetProperty("creative_intent_id").GetString());
        }
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/v1/creative-intents/{intentId}")).StatusCode);

        var journalId = $"journal_{Guid.NewGuid():N}";
        using (var journal = new HttpRequestMessage(HttpMethod.Post, "/v1/journal-entries"))
        {
            journal.Headers.Add("X-CSRF-TOKEN", token);
            journal.Content = JsonContent.Create(new
            {
                id = journalId,
                createdAt = DateTimeOffset.UtcNow,
                intent = "保留现场关系",
                gearName = "测试摄影包",
                direction = "尝试所选方向",
                focal = "35mm",
                method = "先观察再移动",
                reflection = "记录取舍，不评价照片",
                creativeIntentId = intentId
            });
            Assert.Equal(HttpStatusCode.OK, (await owner.SendAsync(journal)).StatusCode);
        }
        using (var journals = JsonDocument.Parse(await owner.GetStringAsync("/v1/journal-entries")))
        {
            var journal = Assert.Single(journals.RootElement.GetProperty("items").EnumerateArray());
            Assert.Equal(intentId, journal.GetProperty("creativeIntentId").GetString());
            Assert.Equal(directionId, journal.GetProperty("creativeIntent").GetProperty("selected_interpretation_id").GetString());
        }

        using (var deleteTask = new HttpRequestMessage(HttpMethod.Delete, $"/v1/analysis-tasks/{taskId}"))
        {
            deleteTask.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(deleteTask)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.OK, (await owner.GetAsync($"/v1/creative-intents/{intentId}")).StatusCode);

        using var export = await owner.GetAsync("/v1/account/export");
        await using (var stream = await export.Content.ReadAsStreamAsync())
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            using var reader = new StreamReader(archive.GetEntry("manifest.json")!.Open());
            using var manifest = JsonDocument.Parse(await reader.ReadToEndAsync());
            var exportedIntent = Assert.Single(manifest.RootElement.GetProperty("creativeIntents").EnumerateArray());
            Assert.Equal(intentId, exportedIntent.GetProperty("creative_intent_id").GetString());
            Assert.Equal(intentId, Assert.Single(manifest.RootElement.GetProperty("journalEntries").EnumerateArray()).GetProperty("CreativeIntentId").GetString());
        }

        using (var deleteIntent = new HttpRequestMessage(HttpMethod.Delete, $"/v1/creative-intents/{intentId}"))
        {
            deleteIntent.Headers.Add("X-CSRF-TOKEN", token);
            Assert.Equal(HttpStatusCode.NoContent, (await owner.SendAsync(deleteIntent)).StatusCode);
        }
        using var oldJournal = JsonDocument.Parse(await owner.GetStringAsync("/v1/journal-entries"));
        Assert.Equal(JsonValueKind.Null, Assert.Single(oldJournal.RootElement.GetProperty("items").EnumerateArray()).GetProperty("creativeIntentId").ValueKind);
    }

    [Fact]
    public async Task Account_Deletion_Cascades_Personalization_Candidates_Intents_And_Journals()
    {
        using var deletionFactory = new ApiFactory();
        using var client = deletionFactory.CreateClient();
        var account = await RegisterAsync(client, "cascade-delete");
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        var userId = session.RootElement.GetProperty("user").GetProperty("id").GetString()!;
        var token = await SessionTokenAsync(client);

        using (var settings = new HttpRequestMessage(HttpMethod.Put, "/v1/personalization/settings"))
        {
            settings.Headers.Add("X-CSRF-TOKEN", token);
            settings.Content = JsonContent.Create(new { memoryEnabled = true, feedbackSyncConsent = true });
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(settings)).StatusCode);
        }
        var taskId = await SubmitAndWaitAsync(client, account, "idem_cascade_delete_001");
        var directionId = await FirstDirectionAsync(client, taskId);
        await SyncDirectionFeedbackAsync(client, token, "client_cascade_delete", taskId, directionId, "worth_trying");

        using var createIntent = new HttpRequestMessage(HttpMethod.Post, $"/v1/analysis-tasks/{taskId}/creative-intents");
        createIntent.Headers.Add("X-CSRF-TOKEN", token);
        createIntent.Content = JsonContent.Create(new { selectedInterpretationId = directionId });
        using var intentResponse = await client.SendAsync(createIntent);
        using var intentBody = JsonDocument.Parse(await intentResponse.Content.ReadAsStringAsync());
        var intentId = intentBody.RootElement.GetProperty("creative_intent_id").GetString()!;

        using (var journal = new HttpRequestMessage(HttpMethod.Post, "/v1/journal-entries"))
        {
            journal.Headers.Add("X-CSRF-TOKEN", token);
            journal.Content = JsonContent.Create(new { id = "journal_cascade_delete", createdAt = DateTimeOffset.UtcNow, intent = "测试注销", gearName = "摄影包", direction = "方向", focal = "35mm", method = "观察", reflection = "", creativeIntentId = intentId });
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(journal)).StatusCode);
        }

        string[] candidateIds;
        await using (var beforeScope = deletionFactory.Services.CreateAsyncScope())
        {
            var database = beforeScope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
            candidateIds = await database.GlobalExperienceCandidates
                .Where(value => value.SourceFeedback != null && value.SourceFeedback.UserId == userId)
                .Select(value => value.Id)
                .ToArrayAsync();
            Assert.Single(candidateIds);
        }

        using (var delete = new HttpRequestMessage(HttpMethod.Post, "/v1/account/delete"))
        {
            delete.Headers.Add("X-CSRF-TOKEN", token);
            delete.Content = JsonContent.Create(new { password = account.Password });
            Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        }

        await using var scope = deletionFactory.Services.CreateAsyncScope();
        var deletedDatabase = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
        Assert.False(await deletedDatabase.Users.AnyAsync(value => value.Id == userId));
        Assert.False(await deletedDatabase.GearKits.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.ReferenceImages.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.AnalysisTasks.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.JournalEntries.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.PersonalizationSettings.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.FeedbackRecords.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.CreativePreferences.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.CreativeIntents.AnyAsync(value => value.UserId == userId));
        Assert.False(await deletedDatabase.GlobalExperienceCandidates.AnyAsync(value => candidateIds.Contains(value.Id)));
    }

    [Fact]
    public async Task Running_Analysis_Can_Be_Canceled_And_Does_Not_Produce_A_Result()
    {
        using var slowFactory = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IVisionProvider>();
            services.AddSingleton<IVisionProvider, SlowVisionProvider>();
        }));
        using var client = slowFactory.CreateClient();
        var account = await RegisterAsync(client, "cancel");
        using var accepted = await client.SendAsync(BuildRequest(CreateJpeg(64, 48), "image/jpeg", "idem_cancel_001", account.CsrfToken, account.GearId));
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        using var acceptedBody = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
        var taskId = acceptedBody.RootElement.GetProperty("analysis_id").GetString()!;

        using var deleteWhileRunning = new HttpRequestMessage(HttpMethod.Delete, $"/v1/analysis-tasks/{taskId}");
        deleteWhileRunning.Headers.Add("X-CSRF-TOKEN", await SessionTokenAsync(client));
        Assert.Equal(HttpStatusCode.Conflict, (await client.SendAsync(deleteWhileRunning)).StatusCode);

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/v1/analysis-tasks/{taskId}/cancel");
        cancel.Headers.Add("X-CSRF-TOKEN", await SessionTokenAsync(client));
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(cancel)).StatusCode);
        using var detail = await WaitForTerminalAsync(client, taskId);
        Assert.Equal("canceled", detail.RootElement.GetProperty("task").GetProperty("status").GetString());
        Assert.Equal("TASK_CANCELLED", detail.RootElement.GetProperty("errorCode").GetString());
        Assert.Equal(JsonValueKind.Null, detail.RootElement.GetProperty("result").ValueKind);
    }

    [Fact]
    public async Task Retention_Sweep_Removes_Expired_Image_But_Keeps_Structured_Result()
    {
        using var retentionFactory = new ApiFactory();
        using var client = retentionFactory.CreateClient();
        var account = await RegisterAsync(client, "retention");
        using var accepted = await client.SendAsync(BuildRequest(CreateJpeg(64, 48), "image/jpeg", "idem_retention_001", account.CsrfToken, account.GearId));
        using var body = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
        var taskId = body.RootElement.GetProperty("analysis_id").GetString()!;
        var imageId = body.RootElement.GetProperty("image_id").GetString()!;
        using var completed = await WaitForResultAsync(client, taskId);

        await using (var scope = retentionFactory.Services.CreateAsyncScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
            var task = await database.AnalysisTasks.FindAsync(taskId);
            task!.CompletedAt = DateTimeOffset.UtcNow.AddDays(-2);
            task.CompletedAtUnixMs = task.CompletedAt.Value.ToUnixTimeMilliseconds();
            await database.SaveChangesAsync();
        }
        var worker = new DataRetentionWorker(
            retentionFactory.Services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new DataRetentionOptions { AnalysisImageDays = 1, SweepMinutes = 60 }),
            NullLogger<DataRetentionWorker>.Instance);
        Assert.True(await worker.SweepAsync(CancellationToken.None) >= 1);

        using var detail = JsonDocument.Parse(await client.GetStringAsync($"/v1/analysis-tasks/{taskId}"));
        Assert.True(detail.RootElement.GetProperty("result").ValueKind == JsonValueKind.Object);
        Assert.False(detail.RootElement.GetProperty("task").GetProperty("imageAvailable").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/v1/reference-images/{imageId}")).StatusCode);
    }

    [Fact]
    public async Task Database_Claim_Allows_Only_One_Worker_To_Start_A_Queued_Task()
    {
        using var claimFactory = new ApiFactory();
        using var client = claimFactory.CreateClient();
        await RegisterAsync(client, "claim");
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        var userId = session.RootElement.GetProperty("user").GetProperty("id").GetString()!;
        var imageId = $"image_{Guid.NewGuid():N}";
        var taskId = $"scene_{Guid.NewGuid():N}";

        await using (var seedScope = claimFactory.Services.CreateAsyncScope())
        {
            var database = seedScope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
            database.ReferenceImages.Add(new ReferenceImageRecord
            {
                Id = imageId, UserId = userId, Sha256 = Guid.NewGuid().ToString("N").PadRight(64, '0'), ContentType = "image/jpeg",
                Content = CreateJpeg(8, 8), Width = 8, Height = 8, ByteLength = CreateJpeg(8, 8).Length, CreatedAt = DateTimeOffset.UtcNow
            });
            database.AnalysisTasks.Add(new AnalysisTaskRecord
            {
                Id = taskId, UserId = userId, ReferenceImageId = imageId, IdempotencyKey = Guid.NewGuid().ToString("N"),
                Fingerprint = Guid.NewGuid().ToString("N").PadRight(64, '0'), Status = AnalysisTaskStatuses.Queued, RequestJson = "{}",
                CreatedAt = DateTimeOffset.UtcNow, CreatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
            await database.SaveChangesAsync();
        }

        await using var firstScope = claimFactory.Services.CreateAsyncScope();
        await using var secondScope = claimFactory.Services.CreateAsyncScope();
        var claims = await Task.WhenAll(
            firstScope.ServiceProvider.GetRequiredService<IAnalysisTaskStore>().ClaimQueuedAsync(taskId, CancellationToken.None),
            secondScope.ServiceProvider.GetRequiredService<IAnalysisTaskStore>().ClaimQueuedAsync(taskId, CancellationToken.None));
        Assert.Single(claims, value => value is not null);
    }

    [Fact]
    public async Task Development_Password_Recovery_Returns_One_Time_Code_And_Resets_Password()
    {
        using var recoveryFactory = factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ApiProtection:AllowLoopbackDevelopmentRecoveryCode"] = "true"
            }));
        });
        using var client = recoveryFactory.CreateClient();
        var account = await RegisterAsync(client, "recovery");
        using var logout = new HttpRequestMessage(HttpMethod.Post, "/v1/account/logout");
        logout.Headers.Add("X-CSRF-TOKEN", await SessionTokenAsync(client));
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);

        var token = await SessionTokenAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/account/request-password-reset");
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Content = JsonContent.Create(new { email = account.Email });
        using var requested = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, requested.StatusCode);
        using var requestedBody = JsonDocument.Parse(await requested.Content.ReadAsStringAsync());
        var recoveryCode = requestedBody.RootElement.GetProperty("developmentRecoveryCode").GetString();
        Assert.False(string.IsNullOrWhiteSpace(recoveryCode));

        using var reset = new HttpRequestMessage(HttpMethod.Post, "/v1/account/reset-password");
        reset.Headers.Add("X-CSRF-TOKEN", token);
        reset.Content = JsonContent.Create(new { email = account.Email, recoveryCode, newPassword = "recovered12345" });
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(reset)).StatusCode);

        token = await SessionTokenAsync(client);
        using var login = new HttpRequestMessage(HttpMethod.Post, "/v1/account/login");
        login.Headers.Add("X-CSRF-TOKEN", token);
        login.Content = JsonContent.Create(new { email = account.Email, password = "recovered12345", rememberMe = false });
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(login)).StatusCode);
    }

    [Fact]
    public async Task Development_Password_Recovery_Hides_Code_Without_Explicit_Loopback_Option()
    {
        using var recoveryFactory = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Development"));
        using var client = recoveryFactory.CreateClient();
        var account = await RegisterAsync(client, "recovery-hidden");
        using var logout = new HttpRequestMessage(HttpMethod.Post, "/v1/account/logout");
        logout.Headers.Add("X-CSRF-TOKEN", await SessionTokenAsync(client));
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);

        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/account/request-password-reset");
        request.Headers.Add("X-CSRF-TOKEN", await SessionTokenAsync(client));
        request.Content = JsonContent.Create(new { email = account.Email });
        using var requested = await client.SendAsync(request);
        using var body = JsonDocument.Parse(await requested.Content.ReadAsStringAsync());
        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("developmentRecoveryCode").ValueKind);
    }

    [Fact]
    public void Development_Recovery_Code_Requires_Explicit_Option_And_Loopback()
    {
        Assert.True(Zhaojian.Api.Endpoints.AccountEndpoints.CanExposeDevelopmentRecoveryCode("Development", true, IPAddress.Loopback));
        Assert.False(Zhaojian.Api.Endpoints.AccountEndpoints.CanExposeDevelopmentRecoveryCode("Development", false, IPAddress.Loopback));
        Assert.False(Zhaojian.Api.Endpoints.AccountEndpoints.CanExposeDevelopmentRecoveryCode("Development", true, IPAddress.Parse("192.0.2.1")));
        Assert.False(Zhaojian.Api.Endpoints.AccountEndpoints.CanExposeDevelopmentRecoveryCode("Production", true, IPAddress.Loopback));
    }

    [Fact]
    public void Gear_Name_Range_Mismatch_Is_Reported_Without_Changing_Recorded_Range()
    {
        Assert.Empty(Zhaojian.Api.Endpoints.ProfileDataEndpoints.GearWarnings("24–70mm F4", 24, 70));
        var warning = Assert.Single(Zhaojian.Api.Endpoints.ProfileDataEndpoints.GearWarnings("18–55mm F3.5–5.6", 18, 190));
        Assert.Contains("18–190mm", warning);
        Assert.Contains("采用记录值", warning);
    }

    private static async Task<TestAccount> RegisterAsync(HttpClient client, string prefix)
    {
        var email = $"{prefix}-{Guid.NewGuid():N}@example.test";
        const string password = "camera12345";
        var csrfToken = await SessionTokenAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/account/register");
        request.Headers.Add("X-CSRF-TOKEN", csrfToken);
        request.Content = JsonContent.Create(new { email, password, displayName = $"摄影者 {prefix}" });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var gearId = $"kit_{Guid.NewGuid():N}";
        var token = await SessionTokenAsync(client);
        using var saveGear = new HttpRequestMessage(HttpMethod.Post, "/v1/gear-kits");
        saveGear.Headers.Add("X-CSRF-TOKEN", token);
        saveGear.Content = JsonContent.Create(new { id = gearId, name = "测试摄影包", camera = "测试机身", sensorWidth = 35.9, sensorHeight = 23.9, cropFactor = 1, lensName = "24-70mm F4", focalMin = 24, focalMax = 70, aperture = 4, minimumAperture = 22, ibisStops = 0, tripod = false, ndStops = Array.Empty<double>(), maxIso = 3200, minIso = 100 });
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(saveGear)).StatusCode);
        return new TestAccount(email, password, token, gearId);
    }

    private static async Task<string> SessionTokenAsync(HttpClient client)
    {
        using var session = JsonDocument.Parse(await client.GetStringAsync("/v1/account/session"));
        return session.RootElement.GetProperty("csrfToken").GetString()!;
    }

    private static async Task<string> SubmitAndWaitAsync(HttpClient client, TestAccount account, string idempotencyKey)
    {
        using var accepted = await client.SendAsync(BuildRequest(
            CreateJpeg(64, 48),
            "image/jpeg",
            idempotencyKey,
            account.CsrfToken,
            account.GearId));
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        using var body = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
        var taskId = body.RootElement.GetProperty("analysis_id").GetString()!;
        using var completed = await WaitForResultAsync(client, taskId);
        return taskId;
    }

    private static async Task<string> FirstDirectionAsync(HttpClient client, string taskId)
    {
        using var detail = JsonDocument.Parse(await client.GetStringAsync($"/v1/analysis-tasks/{taskId}"));
        return detail.RootElement.GetProperty("result").GetProperty("analysis").GetProperty("interpretations")[0].GetProperty("id").GetString()!;
    }

    private static async Task SyncDirectionFeedbackAsync(
        HttpClient client,
        string csrfToken,
        string clientFeedbackId,
        string taskId,
        string directionId,
        string value)
    {
        using var request = await BuildFeedbackSyncRequestAsync(csrfToken, clientFeedbackId, taskId, directionId, value);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static Task<HttpRequestMessage> BuildFeedbackSyncRequestAsync(
        string csrfToken,
        string clientFeedbackId,
        string taskId,
        string directionId,
        string value)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/personalization/feedback/sync");
        request.Headers.Add("X-CSRF-TOKEN", csrfToken);
        request.Content = JsonContent.Create(new
        {
            items = new[]
            {
                new
                {
                    clientFeedbackId,
                    analysisTaskId = taskId,
                    directionId,
                    feedbackType = "direction",
                    value,
                    createdAt = DateTimeOffset.UtcNow
                }
            }
        });
        return Task.FromResult(request);
    }

    private static HttpRequestMessage BuildAnalysisFeedbackSyncRequest(
        string csrfToken,
        string clientFeedbackId,
        string taskId)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/personalization/feedback/sync");
        request.Headers.Add("X-CSRF-TOKEN", csrfToken);
        request.Content = JsonContent.Create(new
        {
            items = new[]
            {
                new
                {
                    clientFeedbackId,
                    analysisTaskId = taskId,
                    directionId = (string?)null,
                    feedbackType = "analysis",
                    value = "helpful",
                    createdAt = DateTimeOffset.UtcNow
                }
            }
        });
        return request;
    }

    private static HttpRequestMessage BuildRequest(byte[] image, string mimeType, string idempotencyKey, string csrfToken, string gearId, string requestJson = "{\"intent\":\"远处亮光与前景形状之间的关系\",\"movementFreedom\":{\"forwardBackward\":false,\"lateral\":true,\"height\":false}}")
    {
        var message = new HttpRequestMessage(HttpMethod.Post, "/v1/scene-analyses");
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        message.Headers.Add("X-CSRF-TOKEN", csrfToken);
        var multipart = new MultipartFormDataContent();
        var file = new ByteArrayContent(image);
        file.Headers.ContentType = MediaTypeHeaderValue.Parse(mimeType);
        multipart.Add(file, "image", "analysis.jpg");
        var requestNode = System.Text.Json.Nodes.JsonNode.Parse(requestJson)!.AsObject();
        requestNode["gearKitId"] = gearId;
        multipart.Add(new StringContent(requestNode.ToJsonString(), Encoding.UTF8), "request");
        message.Content = multipart;
        return message;
    }

    private static byte[] CreateJpeg(int width, int height)
    {
        var bytes = Convert.FromBase64String("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z");
        if (width <= 2048 && height <= 2048) return bytes;
        for (var index = 2; index < bytes.Length - 9; index++)
        {
            if (bytes[index] != 0xff || bytes[index + 1] != 0xc0) continue;
            bytes[index + 5] = (byte)(height >> 8); bytes[index + 6] = (byte)height;
            bytes[index + 7] = (byte)(width >> 8); bytes[index + 8] = (byte)width;
            break;
        }
        return bytes;
    }

    private static byte[] AddApp1Metadata(byte[] jpeg, string value)
    {
        var payload = Encoding.UTF8.GetBytes(value);
        var result = new byte[jpeg.Length + payload.Length + 4];
        jpeg.AsSpan(0, 2).CopyTo(result);
        result[2] = 0xff; result[3] = 0xe1;
        var length = payload.Length + 2;
        result[4] = (byte)(length >> 8); result[5] = (byte)length;
        payload.CopyTo(result.AsSpan(6));
        jpeg.AsSpan(2).CopyTo(result.AsSpan(6 + payload.Length));
        return result;
    }

    private static byte[] CreateCorruptJpeg()
    {
        var valid = CreateJpeg(8, 8);
        return [.. valid.AsSpan(0, valid.Length - 4), 0xff, 0xd9];
    }


    private static async Task<string> ProblemCode(HttpResponseMessage response)
    {
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return body.RootElement.GetProperty("code").GetString()!;
    }

    private static async Task<JsonDocument> WaitForResultAsync(HttpClient client, string taskId)
    {
        var detail = await WaitForTerminalAsync(client, taskId);
        Assert.True(detail.RootElement.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Object);
        return detail;
    }

    private static async Task<JsonDocument> WaitForTerminalAsync(HttpClient client, string taskId)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var json = await client.GetStringAsync($"/v1/analysis-tasks/{taskId}");
            var document = JsonDocument.Parse(json);
            var status = document.RootElement.GetProperty("task").GetProperty("status").GetString();
            if (status is "completed" or "needs_input" or "failed" or "canceled") return document;
            document.Dispose();
            await Task.Delay(25);
        }
        throw new TimeoutException("后台分析任务没有进入终态。");
    }

    private sealed record TestAccount(string Email, string Password, string CsrfToken, string GearId);

    private sealed class SlowVisionProvider : IVisionProvider
    {
        public string Name => "slow";
        public string Model => "slow-test";
        public string PromptVersion => "test";
        public ProviderStatusResponse Status => new(true, "slow", "slow-test", "live", "测试慢模型");

        public async Task<ProviderResult> AnalyzeAsync(VisionInput input, CancellationToken cancellationToken)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
            throw new InvalidOperationException("慢模型不应完成。");
        }
    }
}
