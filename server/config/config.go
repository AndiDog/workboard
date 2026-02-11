package config

import (
	"errors"
	"fmt"
	"os"

	"google.golang.org/protobuf/encoding/protojson"

	"andidog.de/workboard/server/proto"
)

func ReadConfig() (*proto.Config, error) {
	json := os.Getenv("WORKBOARD_CONFIG")
	if json == "" {
		return nil, errors.New("please set environment variable WORKBOARD_CONFIG (use value `{}` for defaults)")
	}

	cfg := &proto.Config{}
	if err := protojson.Unmarshal([]byte(json), cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return cfg, nil
}
