resource "aws_s3_bucket" "content" {
  bucket_prefix = "${var.name}-content-"
}

resource "aws_sqs_queue" "send" {
  name = "${var.name}-send"
}

resource "aws_sqs_queue" "webhooks" {
  name = "${var.name}-webhooks"
}
