import { describe, expect, it } from "bun:test"
import { compressCloud } from "../../src/tool/shell-compress/strategies/cloud"
import { compressShellOutput } from "../../src/tool/shell-compress/index"

describe("compressCloud — aws ec2 describe-instances", () => {
  it("extracts instance id/state/type from the JSON shape", () => {
    const raw = JSON.stringify({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-0123456789abcdef0",
              State: { Name: "running" },
              InstanceType: "t3.micro",
              PrivateIpAddress: "10.0.0.5",
              Placement: { AvailabilityZone: "us-east-1a" },
              Tags: [{ Key: "Name", Value: "web-1" }],
            },
          ],
        },
      ],
    })

    const out = compressCloud(raw, "aws ec2 describe-instances")
    expect(out).not.toBeNull()
    expect(out).toContain("1 instance")
    expect(out).toContain("i-0123456789abcdef0")
    expect(out).toContain("running")
    expect(out).toContain("web-1")
  })
})

describe("compressCloud — aws s3 ls", () => {
  it("summarizes an object listing into a count + size", () => {
    const raw = ["2024-01-15 10:23:45       1234 file1.txt", "2024-01-15 10:24:10       5678 file2.txt"].join("\n")

    const out = compressCloud(raw, "aws s3 ls s3://my-bucket")
    expect(out).toContain("2 objects")
  })
})

describe("compressCloud — kubectl get (table form)", () => {
  it("rolls up a large table into a row count + head", () => {
    const header = "NAME       READY   STATUS    RESTARTS   AGE"
    const rows = Array.from({ length: 50 }, (_, i) => `pod-${i}     1/1     Running   0          1d`)
    const raw = [header, ...rows].join("\n")

    const out = compressCloud(raw, "kubectl get pods")
    expect(out).not.toBeNull()
    expect(out).toContain("50 rows")
    expect(out).toContain("more")
  })

  it("returns null for a small table so the generic tabular strategy still applies", () => {
    const raw = ["NAME       READY   STATUS    RESTARTS   AGE", "pod-a      1/1     Running   0          1d"].join("\n")
    expect(compressCloud(raw, "kubectl get pods")).toBeNull()
  })
})

describe("compressCloud — kubectl describe", () => {
  it("suppresses the verbose Events section", () => {
    const raw = [
      "Name:         my-pod",
      "Namespace:    default",
      "Events:",
      "  Normal  Scheduled  1m  default-scheduler",
    ].join("\n")

    const out = compressCloud(raw, "kubectl describe pod my-pod")
    expect(out).toContain("Events: (suppressed)")
    expect(out).not.toContain("default-scheduler")
  })
})

describe("compressCloud — gcloud (GCP)", () => {
  it("extracts name/status/labels from a --format=json array", () => {
    const raw = JSON.stringify([
      { name: "instance-1", status: "RUNNING", labels: { env: "prod" } },
      { name: "instance-2", status: "TERMINATED", labels: {} },
    ])

    const out = compressCloud(raw, "gcloud compute instances list --format=json")
    expect(out).not.toBeNull()
    expect(out).toContain("2 resources")
    expect(out).toContain("instance-1")
    expect(out).toContain("RUNNING")
    expect(out).toContain("env=prod")
  })

  it("returns null for non-JSON gcloud table output", () => {
    expect(compressCloud("NAME  STATUS\ninstance-1  RUNNING", "gcloud compute instances list")).toBeNull()
  })
})

describe("compressCloud — az (Azure)", () => {
  it("extracts name/provisioningState/tags from a JSON array", () => {
    const raw = JSON.stringify([{ name: "vm-1", provisioningState: "Succeeded", tags: { team: "core" } }])

    const out = compressCloud(raw, "az vm list")
    expect(out).not.toBeNull()
    expect(out).toContain("vm-1")
    expect(out).toContain("Succeeded")
    expect(out).toContain("team=core")
  })

  it("handles a single JSON object (not an array)", () => {
    const raw = JSON.stringify({ name: "vm-1", provisioningState: "Succeeded" })
    const out = compressCloud(raw, "az vm show --name vm-1")
    expect(out).toContain("1 resource")
    expect(out).toContain("vm-1")
  })
})

describe("compressCloud — docker inspect", () => {
  it("extracts id/status/image from a container inspect array", () => {
    const raw = JSON.stringify([
      { Id: "abcdef0123456789", State: { Status: "running" }, Config: { Image: "nginx:latest" }, Name: "/web" },
    ])

    const out = compressCloud(raw, "docker inspect web")
    expect(out).toContain("abcdef012345")
    expect(out).toContain("running")
    expect(out).toContain("nginx:latest")
  })
})

describe("compressCloud — conservative fallback", () => {
  it("returns null for an unrecognized cloud command", () => {
    expect(compressCloud("hello world", "aws sts get-caller-identity")).toBeNull()
  })

  it("returns null for a non-cloud command", () => {
    expect(compressCloud("hello world", "ls -la")).toBeNull()
  })
})

describe("compressShellOutput — cloud parser wired before generic classification", () => {
  it("routes an aws ec2 describe-instances command through the cloud parser", () => {
    const raw = JSON.stringify({
      Reservations: [{ Instances: [{ InstanceId: "i-abc", State: { Name: "running" }, InstanceType: "t3.micro" }] }],
    })

    const result = compressShellOutput("aws ec2 describe-instances", raw)
    expect(result.text).toContain("i-abc")
    expect(result.text).toContain("1 instance")
  })
})
