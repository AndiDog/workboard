package api

import (
	"context"
	"log"

	"andidog.de/workboard/server/proto"
)

type WorkboardServer struct {
	proto.UnimplementedWorkboardServer
}

func NewWorkboardServer() (*WorkboardServer, error) {
	return &WorkboardServer{}, nil
}

func (s WorkboardServer) MarkReviewed(ctx context.Context, cmd *proto.MarkReviewedCommand) (*proto.CommandResponse, error) {
	log.Printf("MarkReviewed")

	return &proto.CommandResponse{}, nil
}
